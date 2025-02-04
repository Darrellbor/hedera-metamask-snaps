/*-
 *
 * Hedera Wallet Snap
 *
 * Copyright (C) 2024 Hedera Hashgraph, LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */

import { rpcErrors } from '@metamask/rpc-errors';
import type { DialogParams } from '@metamask/snaps-sdk';
import { copyable, divider, heading, text } from '@metamask/snaps-sdk';
import _ from 'lodash';
import { HederaClientImplFactory } from '../../client/HederaClientImplFactory';
import { AtomicSwapCommand } from '../../commands/hts/AtomicSwapCommand';
import type { AccountInfo } from '../../types/account';
import type { AtomicSwap, SimpleTransfer, TxRecord } from '../../types/hedera';
import type {
  InitiateSwapRequestParams,
  ServiceFee,
  SignScheduledTxParams,
} from '../../types/params';
import type { WalletSnapParams } from '../../types/state';
import { CryptoUtils } from '../../utils/CryptoUtils';
import { HederaUtils } from '../../utils/HederaUtils';
import { SnapUtils } from '../../utils/SnapUtils';

export class AtomicSwapFacade {
  /**
   * Swap tokens for Hbar or other tokens.
   * @param walletSnapParams - Wallet snap params.
   * @param initiateSwapRequestParams - Parameters for creating an atomic swap.
   * @returns Receipt of the transaction.
   */
  public static async initiateSwap(
    walletSnapParams: WalletSnapParams,
    initiateSwapRequestParams: InitiateSwapRequestParams,
  ): Promise<TxRecord> {
    const { origin, state } = walletSnapParams;

    const {
      atomicSwaps = [] as AtomicSwap[],
      memo = null,
      maxFee = null,
      serviceFee = {
        percentageCut: 0,
        toAddress: '0.0.98', // Hedera Fee collection account
      } as ServiceFee,
    } = initiateSwapRequestParams;

    const { hederaAccountId, hederaEvmAddress, network, mirrorNodeUrl } =
      state.currentAccount;
    const { privateKey, curve } =
      state.accountState[hederaEvmAddress][network].keyStore;

    const transfers: SimpleTransfer[] = [];

    for (const swap of atomicSwaps) {
      transfers.push(swap.requester);
      transfers.push(swap.responder);
    }

    const serviceFeesToPay: Record<string, number> = transfers.reduce<
      Record<string, number>
    >((acc, transfer) => {
      if (!acc[transfer.assetType]) {
        if (transfer.assetType === 'HBAR') {
          acc[transfer.assetType] = 0;
        } else {
          acc[transfer.assetId as string] = 0;
        }
      }
      // Calculate the service fee based on the total amount
      const fee = Number(
        (transfer.amount * (serviceFee.percentageCut / 100.0)).toFixed(2),
      );

      // Deduct the service fee from the total amount to find the new transfer amount
      transfer.amount -= fee / 2.0; // Since these are swaps, we divide the fee by 2 to avoid double charging

      // Record the service fee
      if (transfer.assetType === 'HBAR') {
        acc[transfer.assetType] += fee;
      } else {
        acc[transfer.assetId as string] += fee;
      }

      return acc;
    }, {});

    let txReceipt = {} as TxRecord;

    const hederaClientFactory = new HederaClientImplFactory(
      hederaAccountId,
      network,
      curve,
      privateKey,
    );

    const hederaClient = await hederaClientFactory.createClient();
    if (hederaClient === null) {
      throw rpcErrors.resourceUnavailable('hedera client returned null');
    }

    try {
      await HederaUtils.getMirrorAccountInfo(hederaAccountId, mirrorNodeUrl);

      const panelToShow = SnapUtils.initializePanelToShow();

      panelToShow.push(
        heading('Initiate Atomic Swap'),
        text(
          'Learn more about atomic swap [here](https://docs.hedera.com/hedera/sdks-and-apis/sdks/token-service/atomic-swaps)',
        ),
        text(
          'Are you sure you want to execute the following swap? Note that the responder will also need to approve the swap by calling "hts/completeSwap" API within 30 minutes from now or the transaction will fail.',
        ),
        divider(),
      );
      const strippedMemo = memo ? memo.replace(/\r?\n|\r/gu, '').trim() : '';
      if (strippedMemo) {
        panelToShow.push(text(`Memo:`), copyable(strippedMemo));
      }
      if (maxFee) {
        panelToShow.push(text(`Max Transaction Fee: ${maxFee} Hbar`));
      }

      for (const swap of atomicSwaps) {
        const txNumber = atomicSwaps.indexOf(swap) + 1;

        panelToShow.push(divider(), text(`Swap #${txNumber}`), divider());

        let accountIdToSendFrom = hederaAccountId;
        swap.requester = await this.createTxDialog(
          accountIdToSendFrom,
          swap.requester,
          mirrorNodeUrl,
          panelToShow,
          serviceFeesToPay,
          true,
        );

        panelToShow.push(divider());

        accountIdToSendFrom = swap.requester.to;
        swap.responder.to = hederaAccountId;
        swap.responder = await this.createTxDialog(
          accountIdToSendFrom,
          swap.responder,
          mirrorNodeUrl,
          panelToShow,
          serviceFeesToPay,
          false,
        );
      }

      const dialogParams: DialogParams = {
        type: 'confirmation',
        content: await SnapUtils.generateCommonPanel(
          origin,
          network,
          mirrorNodeUrl,
          panelToShow,
        ),
      };
      const confirmed = await SnapUtils.snapDialog(dialogParams);
      if (!confirmed) {
        const errMessage = 'User rejected the transaction';
        console.error(errMessage);
        throw rpcErrors.transactionRejected(errMessage);
      }

      const command = new AtomicSwapCommand(
        atomicSwaps,
        memo,
        maxFee,
        serviceFeesToPay,
        serviceFee.toAddress as string,
      );

      txReceipt = await command.initiateSwap(hederaClient.getClient());
      await SnapUtils.snapCreateDialogAfterTransaction(network, txReceipt);

      return txReceipt;
    } catch (error: any) {
      const errMessage = `Error while trying to initiate atomic swap`;
      console.error('Error occurred: %s', errMessage, String(error));
      await SnapUtils.snapNotification(
        `Error occurred: ${errMessage} - ${String(error)}`,
      );
      throw rpcErrors.transactionRejected(errMessage);
    }
  }

  public static async completeSwap(
    walletSnapParams: WalletSnapParams,
    signScheduledTxParams: SignScheduledTxParams,
  ): Promise<TxRecord> {
    const { origin, state } = walletSnapParams;
    const { scheduleId } = signScheduledTxParams;

    const { hederaAccountId, hederaEvmAddress, network, mirrorNodeUrl } =
      state.currentAccount;
    const { privateKey, curve } =
      state.accountState[hederaEvmAddress][network].keyStore;

    let txReceipt = {} as TxRecord;

    const hederaClientFactory = new HederaClientImplFactory(
      hederaAccountId,
      network,
      curve,
      privateKey,
    );

    const hederaClient = await hederaClientFactory.createClient();
    if (hederaClient === null) {
      throw rpcErrors.resourceUnavailable('hedera client returned null');
    }

    try {
      const panelToShow = SnapUtils.initializePanelToShow();

      panelToShow.push(
        heading('Complete Atomic Swap'),
        text(
          'Learn more about atomic swap [here](https://docs.hedera.com/hedera/sdks-and-apis/sdks/token-service/atomic-swaps)',
        ),
        text(
          'Are you sure you want to execute the following swap? Note that all the parties involved in the swap must approve the swap within 30 minutes from now or the transaction will fail.',
        ),
        divider(),
      );

      panelToShow.push(
        text(`Atomic Swap Scheduled Transaction ID:`),
        copyable(scheduleId),
      );
      panelToShow.push(divider());

      const dialogParams: DialogParams = {
        type: 'confirmation',
        content: await SnapUtils.generateCommonPanel(
          origin,
          network,
          mirrorNodeUrl,
          panelToShow,
        ),
      };
      const confirmed = await SnapUtils.snapDialog(dialogParams);
      if (!confirmed) {
        const errMessage = 'User rejected the transaction';
        console.error(errMessage);
        throw rpcErrors.transactionRejected(errMessage);
      }

      const command = new AtomicSwapCommand([], null, null, {}, null);

      txReceipt = await command.completeSwap(
        hederaClient.getClient(),
        scheduleId,
      );
      await SnapUtils.snapCreateDialogAfterTransaction(network, txReceipt);

      return txReceipt;
    } catch (error: any) {
      const errMessage = `Error while trying to complete atomic swap`;
      console.error('Error occurred: %s', errMessage, String(error));
      await SnapUtils.snapNotification(
        `Error occurred: ${errMessage} - ${String(error)}`,
      );
      throw rpcErrors.transactionRejected(errMessage);
    }
  }

  /**
   * Create a transaction dialog for atomic swap.
   * @param accountIdToSendFrom - Hedera account ID to send from.
   * @param transfer - Simple transfer.
   * @param mirrorNodeUrl - Mirror node URL.
   * @param panelToShow - Panel to show.
   * @param serviceFeesToPay - Service fees to pay.
   * @param isRequester - Is requester.
   * @returns Simple transfer.
   */
  // eslint-disable-next-line no-restricted-syntax
  private static async createTxDialog(
    accountIdToSendFrom: string,
    transfer: SimpleTransfer,
    mirrorNodeUrl: string,
    panelToShow: any[],
    serviceFeesToPay: Record<string, number>,
    isRequester: boolean,
  ): Promise<SimpleTransfer> {
    const newTransfer = transfer;
    let asset = '';
    let feeToDisplay = 0;

    if (newTransfer.from !== undefined && !_.isEmpty(newTransfer.from)) {
      const errMessage = `Atomic Swaps cannot be done with delegated transfers at this time`;
      console.error(errMessage);
      throw rpcErrors.methodNotSupported(errMessage);
    }
    panelToShow.push(
      text(`Swap ${isRequester ? 'Requester' : 'Responder'}`),
      copyable(accountIdToSendFrom),
    );

    const ownerAccountInfo: AccountInfo =
      await HederaUtils.getMirrorAccountInfo(
        accountIdToSendFrom,
        mirrorNodeUrl,
      );
    const walletBalance = ownerAccountInfo.balance;

    panelToShow.push(text(`Asset Type: ${newTransfer.assetType}`));
    if (newTransfer.assetType === 'HBAR') {
      if (walletBalance.hbars < transfer.amount + serviceFeesToPay.HBAR) {
        const errMessage = `There is not enough Hbar in the wallet to transfer the requested amount`;
        console.error(errMessage);
        panelToShow.push(text(errMessage));
        panelToShow.push(
          text(
            `Proceed only if you are sure about the amount being transferred`,
          ),
        );
      }
      asset = 'HBAR';
    } else {
      transfer.decimals = walletBalance.tokens[transfer.assetId as string]
        ? walletBalance.tokens[transfer.assetId as string].decimals
        : NaN;
      if (
        !walletBalance.tokens[transfer.assetId as string] ||
        walletBalance.tokens[transfer.assetId as string].balance <
          transfer.amount
      ) {
        const errMessage = `This wallet either does not own  ${
          transfer.assetId as string
        } or there is not enough balance to transfer the requested amount`;
        console.error(errMessage);
        panelToShow.push(text(errMessage));
        panelToShow.push(
          text(
            `Proceed only if you are sure about the amount being transferred`,
          ),
        );
      }

      let assetId = newTransfer.assetId as string;
      let nftSerialNumber = '';
      if (newTransfer.assetType === 'NFT') {
        const assetIdSplit = assetId.split('/');
        assetId = assetIdSplit[0];
        nftSerialNumber = assetIdSplit[1];
      }
      panelToShow.push(text(`Asset Id:`), copyable(assetId));
      const tokenInfo = await CryptoUtils.getTokenById(assetId, mirrorNodeUrl);
      if (_.isEmpty(tokenInfo)) {
        const errMessage = `Error while trying to get token info for ${assetId} from Hedera Mirror Nodes at this time`;
        console.error(errMessage);
        panelToShow.push(text(errMessage));
        panelToShow.push(
          text(
            `Proceed only if you are sure about the asset ID being transferred`,
          ),
        );
      } else {
        asset = tokenInfo.symbol;
        panelToShow.push(text(`Asset Name: ${tokenInfo.name}`));
        panelToShow.push(text(`Asset Type: ${tokenInfo.type}`));
        panelToShow.push(text(`Symbol: ${tokenInfo.symbol}`));
        newTransfer.decimals = Number(tokenInfo.decimals);
      }
      if (!Number.isFinite(newTransfer.decimals)) {
        const errMessage = `decimals is not a finite number`;
        console.error(errMessage);
        throw rpcErrors.invalidParams(errMessage);
      }

      if (newTransfer.assetType === 'NFT') {
        panelToShow.push(text(`NFT Serial Number: ${nftSerialNumber}`));
      }

      if (serviceFeesToPay[newTransfer.assetType] > 0) {
        feeToDisplay = serviceFeesToPay[newTransfer.assetType];
      } else {
        feeToDisplay = serviceFeesToPay[newTransfer.assetId as string];
      }
    }
    panelToShow.push(text(`To:`), copyable(newTransfer.to));
    panelToShow.push(text(`Amount: ${newTransfer.amount} ${asset}`));
    if (feeToDisplay > 0) {
      panelToShow.push(
        SnapUtils.formatFeeDisplay(feeToDisplay, newTransfer),
        SnapUtils.formatFeeDisplay(
          newTransfer.amount + feeToDisplay,
          newTransfer,
        ),
      );
    }
    return newTransfer;
  }
}
