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
import { AssociateTokensCommand } from '../../commands/hts/AssociateTokensCommand';
import type { TxRecord } from '../../types/hedera';
import type { AssociateTokensRequestParams } from '../../types/params';
import type { WalletSnapParams } from '../../types/state';
import { CryptoUtils } from '../../utils/CryptoUtils';
import { SnapUtils } from '../../utils/SnapUtils';

export class AssociateTokensFacade {
  /**
   * Associates the provided Hedera account with the provided Hedera token(s).
   *
   * Hedera accounts must be associated with a fungible or non-fungible token first
   * before you can transfer tokens to that account.  In the case of NON_FUNGIBLE Type,
   * once an account is associated, it can hold any number of NFTs (serial numbers)
   * of that token type. There is currently no limit on the number of token IDs that
   * can be associated with an account (reference HIP-367). Still, you can see
   * TOKENS_PER_ACCOUNT_LIMIT_EXCEEDED responses for pre-HIP-367 transactions.
   * @param walletSnapParams - Wallet snap params.
   * @param associateTokensRequestParams - Parameters for associating tokens to the account.
   * @returns Receipt of the transaction.
   */
  public static async associateTokens(
    walletSnapParams: WalletSnapParams,
    associateTokensRequestParams: AssociateTokensRequestParams,
  ): Promise<TxRecord> {
    const { origin, state } = walletSnapParams;

    const { tokenIds = [] as string[] } = associateTokensRequestParams;

    const { hederaEvmAddress, hederaAccountId, network, mirrorNodeUrl } =
      state.currentAccount;

    const { privateKey, curve } =
      state.accountState[hederaEvmAddress][network].keyStore;

    let txReceipt = {} as TxRecord;
    try {
      const panelToShow = SnapUtils.initializePanelToShow();

      panelToShow.push(
        heading('Associate Tokens'),
        text(
          'Are you sure you want to associate the following tokens to your account?',
        ),
        divider(),
      );

      for (const tokenId of tokenIds) {
        const tokenNumber = tokenIds.indexOf(tokenId) + 1;
        panelToShow.push(text(`Token #${tokenNumber}`));
        panelToShow.push(divider());

        panelToShow.push(text(`Asset Id:`), copyable(tokenId));
        const tokenInfo = await CryptoUtils.getTokenById(
          tokenId,
          mirrorNodeUrl,
        );
        if (_.isEmpty(tokenInfo)) {
          const errMessage = `Error while trying to get token info for ${tokenId} from Hedera Mirror Nodes at this time`;
          console.error(errMessage);
          panelToShow.push(text(errMessage));
          panelToShow.push(
            text(`Proceed only if you are sure this asset ID exists`),
          );
        } else {
          panelToShow.push(text(`Asset Name: ${tokenInfo.name}`));
          panelToShow.push(text(`Asset Type: ${tokenInfo.type}`));
          panelToShow.push(text(`Symbol: ${tokenInfo.symbol}`));
          panelToShow.push(
            text(
              `Total Supply: ${(
                Number(tokenInfo.total_supply) /
                Math.pow(10, Number(tokenInfo.decimals))
              ).toString()}`,
            ),
          );
          panelToShow.push(
            text(
              `Max Supply: ${(
                Number(tokenInfo.max_supply) /
                Math.pow(10, Number(tokenInfo.decimals))
              ).toString()}`,
            ),
          );
        }
        panelToShow.push(divider());
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
      const command = new AssociateTokensCommand(tokenIds);
      txReceipt = await command.execute(hederaClient.getClient());
      await SnapUtils.snapCreateDialogAfterTransaction(network, txReceipt);

      return txReceipt;
    } catch (error: any) {
      const errMessage = `Error while trying to associate tokens to the account`;
      console.error('Error occurred: %s', errMessage, String(error));
      await SnapUtils.snapNotification(
        `Error occurred: ${errMessage} - ${String(error)}`,
      );
      throw rpcErrors.transactionRejected(errMessage);
    }
  }
}
