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
import type { DialogParams, NodeType } from '@metamask/snaps-sdk';
import { copyable, divider, heading, text } from '@metamask/snaps-sdk';
import { HederaClientImplFactory } from '../../client/HederaClientImplFactory';
import { CreateTopicCommand } from '../../commands/hcs/CreateTopicCommand';
import type { TxReceipt } from '../../types/hedera';
import type { CreateTopicRequestParams } from '../../types/params';
import type { WalletSnapParams } from '../../types/state';
import { SnapUtils } from '../../utils/SnapUtils';

export class CreateTopicFacade {
  /**
   * Creates a new topic on the Hedera network.
   * @param walletSnapParams - Wallet snap params.
   * @param createTopicParams - Parameters for creating a topic.
   * @returns Receipt of the transaction.
   */
  public static async createTopic(
    walletSnapParams: WalletSnapParams,
    createTopicParams: CreateTopicRequestParams,
  ): Promise<TxReceipt> {
    const { origin, state } = walletSnapParams;

    const { hederaEvmAddress, hederaAccountId, network, mirrorNodeUrl } =
      state.currentAccount;

    const { memo, adminKey, submitKey, autoRenewPeriod, autoRenewAccount } =
      createTopicParams;

    const { privateKey, curve } =
      state.accountState[hederaEvmAddress][network].keyStore;

    let txReceipt = {} as TxReceipt;
    try {
      const panelToShow: (
        | {
            value: string;
            type: NodeType.Heading;
          }
        | {
            value: string;
            type: NodeType.Text;
            markdown?: boolean | undefined;
          }
        | {
            type: NodeType.Divider;
          }
        | {
            value: string;
            type: NodeType.Copyable;
            sensitive?: boolean | undefined;
          }
      )[] = [];

      panelToShow.push(
        heading('Create a new topic'),
        text(
          `Learn more about creating topics [here](https://docs.hedera.com/hedera/sdks-and-apis/hedera-api/consensus/consensuscreatetopic)`,
        ),
        text(
          `You are about to create a new topic with the following parameters:`,
        ),
        divider(),
      );

      if (memo !== undefined) {
        panelToShow.push(text(`Memo: ${memo}`));
      }
      if (adminKey !== undefined) {
        panelToShow.push(text(`Admin Key:`), copyable(adminKey));
      }
      if (submitKey !== undefined) {
        panelToShow.push(text(`Submit Key:`), copyable(submitKey));
      }
      if (autoRenewPeriod !== undefined) {
        panelToShow.push(text(`Auto Renew Period: ${autoRenewPeriod}`));
      }
      if (autoRenewAccount !== undefined) {
        panelToShow.push(
          text(`Auto Renew Account:`),
          copyable(autoRenewAccount),
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
      const command = new CreateTopicCommand(
        memo,
        adminKey,
        submitKey,
        autoRenewPeriod,
        autoRenewAccount,
      );

      txReceipt = await command.execute(hederaClient.getClient());
    } catch (error: any) {
      const errMessage = 'Error while trying to create a topic';
      console.error('Error occurred: %s', errMessage, String(error));
      throw rpcErrors.transactionRejected(errMessage);
    }

    return txReceipt;
  }
}
