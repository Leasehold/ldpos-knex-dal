const crypto = require('crypto');
const {firstOrNull, isEmpty, arrOrDefault} = require('./utils');
const KnexClient = require('../knex/knex-client');
const {ballotsTable, multisigMembershipsTable, blocksTable, accountsTable, delegatesTable, transactionsTable, storeTable} = require('../knex/ldpos-table-schema');
const DalParser = require('./parsers');
const DEFAULT_NETWORK_SYMBOL = 'ldpos';
const ID_BYTE_SIZE = 20;

class DAL {
  constructor(config) {
    config = config || {};
    this.logger = config.logger || console;
    this.knexClient = new KnexClient(config);
    this.parsers = new DalParser(this.knexClient).getRecordedParsers();
  }

  async init(options) {
    this.ballotsRepo = this.repository(ballotsTable.name, ballotsTable.field.id);
    this.accountsRepo = this.repository(accountsTable.name, accountsTable.field.address);
    this.transactionsRepo = this.repository(transactionsTable.name, transactionsTable.field.id);
    this.blocksRepo = this.repository(blocksTable.name, blocksTable.field.id);
    this.delegatesRepo = this.repository(delegatesTable.name, delegatesTable.field.address);
    this.multisigMembershipsRepo = ((tableName, ...primaryKeys) => {
      const msmRepo = this.repository(tableName, ...primaryKeys);
      return {
        ...msmRepo,
        multsigAccountAddress: (address) => ({
          ...msmRepo.multsigAccountAddress(address),
          get: () => msmRepo.multsigAccountAddress(address).get().then(r => r. map(a => a[primaryKeys[1]])),
        })
      };
    })(multisigMembershipsTable.name, multisigMembershipsTable.field.multsigAccountAddress, multisigMembershipsTable.field.memberAddress);

    this.storeRepo = this.repository(storeTable.name, storeTable.field.key);
    await this.knexClient.migrateLatest();

    let {genesis} = options;
    let {accounts} = genesis;
    let multisigWalletList = genesis.multisigWallets || [];
    this.networkSymbol = genesis.networkSymbol || DEFAULT_NETWORK_SYMBOL;

    if (await this.knexClient.areAllTablesEmpty()) {
      await Promise.all(
        accounts.map(async (accountInfo) => {
          let {votes, ...accountWithoutVotes} = accountInfo;
          let account = {
            ...accountWithoutVotes,
            type: accountWithoutVotes.type || 'sig',
            updateHeight: 0,
          };
          await this.upsertAccount(account);
          if (account.forgingPublicKey) {
            await this.upsertDelegate({
              address: account.address,
              voteWeight: '0',
            });
          }
        })
      );

      for (let accountInfo of accounts) {
        let {votes} = accountInfo;
        for (let delegateAddress of votes) {
          await this.vote({
            id: crypto.randomBytes(ID_BYTE_SIZE).toString('hex'),
            voterAddress: accountInfo.address,
            delegateAddress
          });
          let delegate = await this.getDelegate(delegateAddress);
          let updatedVoteWeight = BigInt(delegate.voteWeight) + BigInt(accountInfo.balance);
          await this.upsertDelegate({
            address: delegateAddress,
            voteWeight: updatedVoteWeight.toString()
          });
        }
      }

      await Promise.all(
        multisigWalletList.map(async (multisigWallet) => {
          await this.registerMultisigWallet(
            multisigWallet.address,
            multisigWallet.members,
            multisigWallet.requiredSignatureCount,
          );
        })
      );
    }
  }

  async saveItem(key, value) {
    const item = {
      [storeTable.field.key]: key,
      [storeTable.field.value]: value,
    };
    await this.storeRepo.upsert(item);
  }

  async loadItem(key) {
    const keyValuePair = firstOrNull(await this.storeRepo.key(key).get());
    return keyValuePair ? keyValuePair[storeTable.field.value] : null;
  }

  async getNetworkSymbol() {
    return this.networkSymbol;
  }

  async upsertAccount(account) {
    await this.accountsRepo.upsert(account);
  }

  async hasAccount(walletAddress) {
    return await this.accountsRepo.address(walletAddress).exists();
  }

  async getAccount(walletAddress) {
    const account = firstOrNull(await this.accountsRepo.address(walletAddress).get());
    if (!account) {
      let error = new Error(`Account ${walletAddress} did not exist`);
      error.name = 'AccountDidNotExistError';
      error.type = 'InvalidActionError';
      throw error;
    }
    return {...account};
  }

  async getAccountsByBalance(offset, limit, order) {
    return this.accountsRepo.buildBaseQuery()
      .orderBy(accountsTable.field.balance, order)
      .offset(offset)
      .limit(limit);
  }

  async getAccountVotes(voterAddress) {
    if (await this.accountsRepo.address(voterAddress).notExist()) {
      let error = new Error(`Voter ${voterAddress} did not exist`);
      error.name = 'VoterAccountDidNotExistError';
      error.type = 'InvalidActionError';
      throw error;
    }
    const activeVotesMatcher = {
      [ballotsTable.field.active]: true,
      [ballotsTable.field.type]: 'vote',
      [ballotsTable.field.voterAddress]: voterAddress,
    };
    const ballots = await this.ballotsRepo.get(activeVotesMatcher);
    return ballots.map(ballot => ballot[ballotsTable.field.delegateAddress]);
  }

  async hasVoteForDelegate(voterAddress, delegateAddress) {
    const existingVotesMatcher = {
      [ballotsTable.field.active]: true,
      [ballotsTable.field.type]: 'vote',
      [ballotsTable.field.voterAddress]: voterAddress,
      [ballotsTable.field.delegateAddress]: delegateAddress,
    };
    return await this.ballotsRepo.exists(existingVotesMatcher);
  }

  async vote(ballot) {
    const { id, voterAddress, delegateAddress } = ballot;
    if (await this.ballotsRepo.id(id).notExist()) {
      const hasExistingVote = await this.hasVoteForDelegate(voterAddress, delegateAddress);
      if (hasExistingVote) {
        let error = new Error(
          `Voter ${voterAddress} has already voted for delegate ${delegateAddress}`
        );
        error.name = 'VoterAlreadyVotedForDelegateError';
        error.type = 'InvalidActionError';
        throw error;
      }
      const existingUnvotesMatcher = {
        [ballotsTable.field.active]: true,
        [ballotsTable.field.type]: 'unvote',
        [ballotsTable.field.voterAddress]: voterAddress,
        [ballotsTable.field.delegateAddress]: delegateAddress,
      }
      const markInactive = {[ballotsTable.field.active]: false};
      await this.ballotsRepo.update(markInactive, existingUnvotesMatcher);
    }
    ballot = {...ballot, type: 'vote', active: true};
    await this.ballotsRepo.upsert(ballot);
  }

  async unvote(ballot) {
    const { id, voterAddress, delegateAddress } = ballot;

    if (await this.ballotsRepo.id(id).notExist()) {
      const existingVotesMatcher = {
        [ballotsTable.field.active]: true,
        [ballotsTable.field.type]: 'vote',
        [ballotsTable.field.voterAddress]: voterAddress,
        [ballotsTable.field.delegateAddress]: delegateAddress,
      };

      const existingUnvotesMatcher = {
        [ballotsTable.field.active]: true,
        [ballotsTable.field.type]: 'unvote',
        [ballotsTable.field.voterAddress]: voterAddress,
        [ballotsTable.field.delegateAddress]: delegateAddress,
      };

      const hasNoExistingVotes = await this.ballotsRepo.notExist(existingVotesMatcher);
      const hasExistingUnvotes = await this.ballotsRepo.exists(existingUnvotesMatcher);

      if (hasNoExistingVotes || hasExistingUnvotes) {
        let error = new Error(
          `Voter ${voterAddress} could not unvote delegate ${delegateAddress} because it was not voting for it`
        );
        error.name = 'VoterNotVotingForDelegateError';
        error.type = 'InvalidActionError';
        throw error;
      }

      const markInactive = {[ballotsTable.field.active]: false};
      await this.ballotsRepo.update(markInactive, existingVotesMatcher);
    }
    ballot = {...ballot,  type: 'unvote', active: true};
    await this.ballotsRepo.upsert(ballot);
  }

  async registerMultisigWallet(multisigAddress, memberAddresses, requiredSignatureCount) {
    const multisigAccount = await this.getAccount(multisigAddress);
    for (let memberAddress of memberAddresses) {
      let memberAccount = await this.getAccount(memberAddress);
      if (!memberAccount.multisigPublicKey) {
        let error = new Error(
          `Account ${memberAddress} was not registered for multisig so it cannot be a member of a multisig wallet`
        );
        error.name = 'MemberAccountWasNotRegisteredError';
        error.type = 'InvalidActionError';
        throw error;
      }
      if (memberAccount.type === 'multisig') {
        let error = new Error(
          `Account ${
            memberAddress
          } was a multisig wallet so it could not be registered as a member of another multisig wallet`
        );
        error.name = 'MemberAccountWasMultisigAccountError';
        error.type = 'InvalidActionError';
        throw error;
      }
    }

    multisigAccount.type = 'multisig';
    multisigAccount.requiredSignatureCount = requiredSignatureCount;
    await this.upsertAccount(multisigAccount);

    for (let memberAddress of memberAddresses) {
      const multiSigMembership = {
        [multisigMembershipsTable.field.multsigAccountAddress]: multisigAddress,
        [multisigMembershipsTable.field.memberAddress]: memberAddress,
      };
      await this.multisigMembershipsRepo.upsert(multiSigMembership);
    }
  }

  async getMultisigWalletMembers(multisigAddress) {
    let memberAddresses = await this.multisigMembershipsRepo.multsigAccountAddress(multisigAddress).get();
    if (isEmpty(memberAddresses)) {
      let error = new Error(
        `Address ${multisigAddress} is not registered as a multisig wallet`
      );
      error.name = 'MultisigAccountDidNotExistError';
      error.type = 'InvalidActionError';
      throw error;
    }
    return [...memberAddresses];
  }

  async getBlocksFromHeight(height, limit) {
    if (height < 1) {
      height = 1;
    }
    let blocks = await this.blocksRepo.buildBaseQuery()
      .orderBy(blocksTable.field.height, 'asc')
      .where(blocksTable.field.height, '>=', height)
      .limit(limit);
    return blocks.map(block => this.simplifyBlock(block));
  }

  async getSignedBlocksFromHeight(height, limit) {
    if (height < 1) {
      height = 1;
    }
    let blocks = await this.blocksRepo.buildBaseQuery()
      .orderBy(blocksTable.field.height, 'asc')
      .where(blocksTable.field.height, '>=', height)
      .limit(limit);
    await Promise.all(
      blocks.map(async (block) => {
        block.transactions = await this.getSanitizedTransactionsFromBlock(block.id);
      })
    );
    return blocks;
  }

  async getSanitizedTransactionsFromBlock(blockId) {
    let txns = await this.getTransactionsFromBlock(blockId);
    for (let txn of txns) {
      delete txn.indexInBlock;
      delete txn.blockId;
    }
    return txns;
  }

  async getLastBlockAtTimestamp(timestamp) {
    const blocks = await this.blocksRepo.buildBaseQuery()
      .orderBy(blocksTable.field.timestamp, 'desc')
      .where(blocksTable.field.timestamp, '<=', timestamp)
      .limit(1);
    const block = firstOrNull(blocks);
    if (!block) {
      let error = new Error(
        `No block existed with timestamp less than or equal to ${timestamp}`
      );
      error.name = 'BlockDidNotExistError';
      error.type = 'InvalidActionError';
      throw error;
    }
    return this.simplifyBlock(block);
  }

  async getBlocksBetweenHeights(fromHeight, toHeight, limit) {
    let blocks = await this.blocksRepo.buildBaseQuery()
      .orderBy(blocksTable.field.height, 'asc')
      .where(blocksTable.field.height, '>', fromHeight)
      .andWhere(blocksTable.field.height, '<=', toHeight)
      .limit(limit);
    return blocks.map(block => this.simplifyBlock(block));
  }

  async getBlockAtHeight(height) {
    const heightMatcher = {[blocksTable.field.height]: height};
    const block = firstOrNull(await this.blocksRepo.get(heightMatcher));
    if (!block) {
      let error = new Error(
        `No block existed at height ${height}`
      );
      error.name = 'BlockDidNotExistError';
      error.type = 'InvalidActionError';
      throw error;
    }
    return this.simplifyBlock(block);
  }

  async getSignedBlockAtHeight(height) {
    const heightMatcher = {[blocksTable.field.height]: height};
    const block = firstOrNull(await this.blocksRepo.get(heightMatcher));
    if (!block) {
      let error = new Error(
        `No block existed at height ${height}`
      );
      error.name = 'BlockDidNotExistError';
      error.type = 'InvalidActionError';
      throw error;
    }
    block.transactions = await this.getSanitizedTransactionsFromBlock(block.id);
    return block;
  }

  async getSignedBlock(id) {
    const block = firstOrNull(await this.blocksRepo.id(id).get());
    if (!block) {
      let error = new Error(
        `No block existed with ID ${id}`
      );
      error.name = 'BlockDidNotExistError';
      error.type = 'InvalidActionError';
      throw error;
    }
    return block;
  }

  async hasBlock(id) {
    return await this.blocksRepo.id(id).exists();
  }

  async getBlock(id) {
    const block = await this.getSignedBlock(id);
    return this.simplifyBlock(block);
  }

  async getBlocksByTimestamp(offset, limit, order) {
    let blocks = await this.blocksRepo.buildBaseQuery()
      .orderBy(blocksTable.field.timestamp, order)
      .offset(offset)
      .limit(limit);
    return blocks.map(block => this.simplifyBlock(block));
  }

  async upsertBlock(block, synched) {
    const { transactions, signatures, ...pureBlock } = block;
    pureBlock.signatures = Buffer.from(JSON.stringify(signatures), 'utf8').toString('base64');
    pureBlock.synched = synched || false;
    await this.blocksRepo.upsert(pureBlock, blocksTable.field.height);
    for (const [index, transaction] of transactions.entries()) {
      const updatedTransaction = {
        ...transaction
      };
      if (transaction.memberAddresses) {
        updatedTransaction.memberAddresses = transaction.memberAddresses.join(',');
      }
      if (transaction.signatures) {
        updatedTransaction.signatures = Buffer.from(JSON.stringify(transaction.signatures), 'utf8').toString('base64');
      }
      updatedTransaction[transactionsTable.field.blockId] = block.id;
      updatedTransaction[transactionsTable.field.indexInBlock] = index;
      await this.transactionsRepo.upsert(updatedTransaction);
    }
  }

  async getMaxBlockHeight() {
    return await this.blocksRepo.count();
  }

  async hasTransaction(transactionId) {
    return await this.transactionsRepo.id(transactionId).exists();
  }

  async getTransaction(transactionId) {
    const transaction = firstOrNull(await this.transactionsRepo.id(transactionId).get());
    if (!transaction) {
      let error = new Error(`Transaction ${transactionId} did not exist`);
      error.name = 'TransactionDidNotExistError';
      error.type = 'InvalidActionError';
      throw error;
    }
    return {...transaction};
  }

  async getTransactionsByTimestamp(offset, limit, order) {
    return this.transactionsRepo.buildBaseQuery()
      .orderBy(transactionsTable.field.timestamp, order)
      .offset(offset)
      .limit(limit);
  }

  async getTransactionsFromBlock(blockId, offset, limit) {
    if (offset == null) {
      offset = 0;
    }
    const baseQuery = this.transactionsRepo.buildBaseQuery()
      .orderBy(transactionsTable.field.indexInBlock, 'asc')
      .where(transactionsTable.field.blockId, blockId)
      .andWhere(transactionsTable.field.indexInBlock, '>=', offset);

    if (limit == null) {
      return baseQuery;
    }
    return baseQuery.limit(limit);
  }

  async getAccountTransactions(walletAddress, fromTimestamp, offset, limit, order) {
    const transactionsQuery = this.transactionsRepo.buildBaseQuery()
      .orderBy(transactionsTable.field.timestamp, order)
      .where(transactionsTable.field.recipientAddress, walletAddress)
      .orWhere(transactionsTable.field.senderAddress, walletAddress)
      .offset(offset)
      .limit(limit);
    if (fromTimestamp != null) {
      if (order === 'desc') {
        transactionsQuery.andWhere(transactionsTable.field.timestamp, '<=', fromTimestamp);
      } else {
        transactionsQuery.andWhere(transactionsTable.field.timestamp, '>=', fromTimestamp);
      }
    }
    return transactionsQuery;
  }

  async getInboundTransactions(walletAddress, fromTimestamp, offset, limit, order) {
    const transactionsQuery = this.transactionsRepo.buildBaseQuery()
      .orderBy(transactionsTable.field.timestamp, order)
      .where(transactionsTable.field.recipientAddress, walletAddress)
      .offset(offset)
      .limit(limit);
    if (fromTimestamp != null) {
      if (order === 'desc') {
        transactionsQuery.andWhere(transactionsTable.field.timestamp, '<=', fromTimestamp);
      } else {
        transactionsQuery.andWhere(transactionsTable.field.timestamp, '>=', fromTimestamp);
      }
    }
    return transactionsQuery;
  }

  async getOutboundTransactions(walletAddress, fromTimestamp, offset, limit, order) {
    const transactionsQuery = this.transactionsRepo.buildBaseQuery()
      .orderBy(transactionsTable.field.timestamp, order)
      .where(transactionsTable.field.senderAddress, walletAddress)
      .offset(offset)
      .limit(limit);
    if (fromTimestamp != null) {
      if (order === 'desc') {
        transactionsQuery.andWhere(transactionsTable.field.timestamp, '<=', fromTimestamp);
      } else {
        transactionsQuery.andWhere(transactionsTable.field.timestamp, '>=', fromTimestamp);
      }
    }
    return transactionsQuery;
  }

  async getInboundTransactionsFromBlock(walletAddress, blockId) {
    const recipientWalletAddressMatcher = {
      [transactionsTable.field.recipientAddress]: walletAddress,
      [transactionsTable.field.blockId]: blockId,
    };
    return await this.transactionsRepo.get(recipientWalletAddressMatcher);
  }

  async getOutboundTransactionsFromBlock(walletAddress, blockId) {
    const senderWalletAddressMatcher = {
      [transactionsTable.field.senderAddress]: walletAddress,
      [transactionsTable.field.blockId]: blockId,
    };
    return await this.transactionsRepo.get(senderWalletAddressMatcher);
  }

  async upsertDelegate(delegate) {
    await this.delegatesRepo.upsert(delegate);
  }

  async hasDelegate(walletAddress) {
    return await this.delegatesRepo.address(walletAddress).exists();
  }

  async getDelegate(walletAddress) {
    const delegate = firstOrNull(await this.delegatesRepo.address(walletAddress).get());
    if (!delegate) {
      let error = new Error(`Delegate ${walletAddress} did not exist`);
      error.name = 'DelegateDidNotExistError';
      error.type = 'InvalidActionError';
      throw error;
    }
    return {...delegate};
  }

  async getDelegatesByVoteWeight(offset, limit, order) {
    return this.delegatesRepo.buildBaseQuery()
      .orderBy(delegatesTable.field.voteWeight, order)
      .orderBy(delegatesTable.field.address, 'asc')
      .offset(offset)
      .limit(limit);
  }

  simplifyBlock(signedBlock) {
    let {forgerSignature, signatures, ...simpleBlock} = signedBlock;
    return simpleBlock;
  }

  repository(tableName, ...primaryKeys) {
    const dataReadParser = this.parsers[tableName];
    const basicRepositoryOps = (defaultMatcher) =>
      ({
        get: (equalityMatcher = defaultMatcher) => this.knexClient.findMatchingRecords(tableName, equalityMatcher, dataReadParser),
        update: (updatedData, equalityMatcher = defaultMatcher) => this.knexClient.updateMatchingRecords(tableName, equalityMatcher, updatedData),
        exists: (equalityMatcher = defaultMatcher) => this.knexClient.matchFound(tableName, equalityMatcher),
        notExist: (equalityMatcher = defaultMatcher) => this.knexClient.noMatchFound(tableName, equalityMatcher),
        count: (equalityMatcher = defaultMatcher) => this.knexClient.findMatchingRecordsCount(tableName, equalityMatcher),
      });

    const generateFieldOps = (fieldName) => ({
      [fieldName]: (value) => basicRepositoryOps({[fieldName]: value}),
    });

    const primaryKeyOps = primaryKeys.reduce((o, key) => ({ ...o, ...generateFieldOps(key)}), {});

    return {
      insert: (data) => this.knexClient.insert(tableName, data),
      upsert: (data, ...byColumns) => this.knexClient.upsert(tableName, data, arrOrDefault(byColumns, primaryKeys)),
      ...basicRepositoryOps({}),
      ...primaryKeyOps,
      buildBaseQuery: (equalityMatcher = {}) => this.knexClient.buildEqualityMatcherQuery(tableName, equalityMatcher, dataReadParser)
    };
  }

  // Clears data from all tables, be careful while using this method
  async clearAllData() {
    await this.knexClient.truncateAllExistingTables();
  }

  async destroy() {
    return this.knexClient.destroy();
  }
}

module.exports = DAL;
