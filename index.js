const DEFAULT_NETWORK_SYMBOL = 'ldpos';

class PostgresDAL {
  async init(options) {
    let { genesis } = options;
    let { accounts } = genesis;
    let multisigWalletList = genesis.multisigWallets || [];
    this.networkSymbol = genesis.networkSymbol || DEFAULT_NETWORK_SYMBOL;

    await Promise.all(
      accounts.map(async (accountInfo) => {
        let { votes, ...accountWithoutVotes } = accountInfo;
        let account = {
          ...accountWithoutVotes,
          updateHeight: 0
        };
        await this.upsertAccount(account);
        await Promise.all(
          votes.map((delegateAddress) => this.upsertVote(account.address, delegateAddress))
        );
      })
    );

    await Promise.all(
      multisigWalletList.map(async (multisigWallet) => {
        await this.registerMultisigWallet(
          multisigWallet.address,
          multisigWallet.members,
          multisigWallet.requiredSignatureCount
        );
      })
    );
  }

  async getNetworkSymbol() {
    return this.networkSymbol;
  }

  async upsertAccount(account) {

  }

  async hasAccount(walletAddress) {

  }

  async getAccount(walletAddress) {

  }

  async updateAccount(walletAddress, changePacket) {

  }

  async getAccountsByBalance(offset, limit, order) {

  }

  async getAccountVotes(voterAddress) {

  }

  async hasVote(voterAddress, delegateAddress) {

  }

  async upsertVote(voterAddress, delegateAddress) {

  }

  async removeVote(voterAddress, delegateAddress) {

  }

  async registerMultisigWallet(multisigAddress, memberAddresses, requiredSignatureCount) {

  }

  async getMultisigWalletMembers(multisigAddress) {

  }

  async getLastBlock() {

  }

  async getBlocksFromHeight(height, limit) {

  }

  async getLastBlockAtTimestamp(timestamp) {

  }

  async getBlocksBetweenHeights(fromHeight, toHeight, limit) {

  }

  async getBlockAtHeight(height) {

  }

  async getBlock(id) {

  }

  async getBlocksByTimestamp(offset, limit, order) {

  }

  async upsertBlock(block, synched) {

  }

  async getMaxBlockHeight() {

  }

  async hasTransaction(transactionId) {

  }

  async getTransaction(transactionId) {

  }

  async upsertTransaction(transaction) {

  }

  async getTransactionsByTimestamp(offset, limit, order) {

  }

  async getTransactionsFromBlock(blockId, offset, limit) {

  }

  async getInboundTransactions(walletAddress, fromTimestamp, limit, order) {

  }

  async getOutboundTransactions(walletAddress, fromTimestamp, limit, order) {

  }

  async getInboundTransactionsFromBlock(walletAddress, blockId) {

  }

  async getOutboundTransactionsFromBlock(walletAddress, blockId) {

  }

  async getDelegatesByVoteWeight(offset, limit, order) {

  }
}

module.exports = PostgresDAL;