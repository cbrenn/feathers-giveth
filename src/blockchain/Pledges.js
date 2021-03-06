import logger from 'winston';
import { hexToNumber, toBN } from 'web3-utils';
import { pledgeState } from './helpers';
import errWrapper from '../utils/to';

class ReProcessEvent extends Error {
  constructor(...args) {
    super(...args);
    Error.captureStackTrace(this, ReProcessEvent);
  }
}

function getDonationStatus(pledge, pledgeAdmin, hasIntendedProject, hasDelegate) {
  if (pledge.pledgeState === '1') return 'paying';
  if (pledge.pledgeState === '2') return 'paid';
  if (hasIntendedProject) return 'to_approve';
  if (pledgeAdmin.type === 'giver' || hasDelegate) return 'waiting';
  return 'committed';
}

class Pledges {
  constructor(app, liquidPledging, eventQueue) {
    this.app = app;
    this.web3 = liquidPledging.$web3;
    this.liquidPledging = liquidPledging;
    this.queue = eventQueue;
    this.blockTimes = {};
    this.fetchingBlocks = {};
    this.processing = {};
  }

  // handle liquidPledging Transfer event
  transfer(event) {
    if (event.event !== 'Transfer') throw new Error('transfer only handles Transfer events');

    const { from, to, amount } = event.returnValues;
    const txHash = event.transactionHash;

    const processEvent = async (retry = false) => {
      const ts = await this.getBlockTimestamp(event.blockNumber);
      if (from === '0') {
        const [err] = await errWrapper(this.newDonation(to, amount, txHash, retry));

        if (err) {
          if (err instanceof ReProcessEvent) {
            // this is really only useful when instant mining. Other then that, the
            // donation should always be created before the tx was mined.
            setTimeout(() => processEvent(true), 5000);
            return;
          }
          logger.error('newDonation error ->', err);
        }
      } else {
        await this._transfer(from, to, amount, ts, txHash);
      }
      await this.queue.purge(txHash);
    };

    // there will be multiple events in a single transaction
    // we need to process them in order so we use a queue
    this.queue.add(event.transactionHash, processEvent);

    if (!this.queue.isProcessing(txHash)) {
      // start processing this event. We add to the queue first, so
      // the queue can track the event processing for the txHash
      this.queue.purge(event.transactionHash);
    }
  }

  newDonation(pledgeId, amount, txHash, retry = false) {
    const donations = this.app.service('donations');
    const pledgeAdmins = this.app.service('pledgeAdmins');

    const findDonation = () =>
      donations
        .find({ query: { txHash } })
        .then(resp => (resp.data.length > 0 ? resp.data[0] : undefined));

    return this.liquidPledging
      .getPledge(pledgeId)
      .then(pledge => Promise.all([pledgeAdmins.get(pledge.owner), pledge, findDonation()]))
      .then(([giver, pledge, donation]) => {
        const mutation = {
          giverAddress: giver.admin.address, // giver is a user type
          amount,
          pledgeId,
          owner: pledge.owner,
          ownerId: giver.typeId,
          ownerType: giver.type,
          status: 'waiting', // waiting for delegation by owner or delegate
          paymentStatus: pledgeState(pledge.pledgeState),
        };

        if (!donation) {
          // if this is the second attempt, then create a donation object
          // otherwise, try an process the event later, giving time for
          // the donation entity to be created via REST api first
          if (retry) {
            return donations.create(Object.assign(mutation, { txHash }));
          }

          // this is really only useful when instant mining. and re-syncing feathers w/ past events.
          // Other then that, the donation should always be created before the tx was mined.
          throw new ReProcessEvent();
        }

        return donations.patch(donation._id, mutation);
      });
  }

  _transfer(from, to, amount, ts, txHash) {
    const donations = this.app.service('donations');
    const pledgeAdmins = this.app.service('pledgeAdmins');

    const getDonation = () =>
      donations
        .find({ schema: 'includeTypeAndGiverDetails', query: { pledgeId: from } })
        .then(donations => {
          if (donations.data.length === 1) return donations.data[0];

          // check for any donations w/ matching txHash
          // this won't work when confirmPayment is called on the vault
          const filteredDonationsByTxHash = donations.data.filter(
            donation => donation.txHash === txHash,
          );

          if (filteredDonationsByTxHash.length === 1) return filteredDonationsByTxHash[0];

          const filteredDonationsByAmount = donations.data.filter(
            donation => donation.amount === amount,
          );

          // possible to have 2 donations w/ same pledgeId & amount. This would happen if a giver makes
          // a donation to the same delegate/project for the same amount multiple times. Currently there
          // no way to tell which donation was acted on if the txHash didn't match, so we just return the first
          if (filteredDonationsByAmount.length > 0) return filteredDonationsByAmount[0];

          // FIXME: The amounts don't match because the params are the same so LPP puts all of the money in one pledge whereas in UI it's multiple donations
          console.log('Amount donation: ', donations.data[0].amount, ' Amount pledge:', amount);

          // TODO is this comment only applicable while we don't support splits?
          // this is probably a split which happened outside of the ui
          throw new Error(
            `unable to determine what donations entity to update -> from: ${from}, to: ${to}, amount: ${amount}, ts: ${ts}, txHash: ${txHash}, donations: ${JSON.stringify(
              donations,
              null,
              2,
            )}`,
          );
        });

    // fetches all necessary data to determine what happened for this Transfer event and calls _doTransfer
    return Promise.all([this.liquidPledging.getPledge(from), this.liquidPledging.getPledge(to)])
      .then(([fromPledge, toPledge]) => {
        const promises = [
          pledgeAdmins.get(fromPledge.owner),
          pledgeAdmins.get(toPledge.owner),
          fromPledge,
          toPledge,
          getDonation(),
        ];

        // In lp any delegate in the chain can delegate, but currently we only allow last delegate
        // to have that ability
        if (toPledge.nDelegates > 0) {
          promises.push(
            this.liquidPledging
              .getPledgeDelegate(to, toPledge.nDelegates)
              .then(delegate => pledgeAdmins.get(delegate.idDelegate)),
          );
        } else {
          promises.push(undefined);
        }

        // fetch intendedProject pledgeAdmin
        if (toPledge.intendedProject > 0) {
          promises.push(pledgeAdmins.get(toPledge.intendedProject));
        } else {
          promises.push(undefined);
        }

        return Promise.all(promises);
      })
      .then(
        ([
          fromPledgeAdmin,
          toPledgeAdmin,
          fromPledge,
          toPledge,
          donation,
          delegate,
          intendedProject,
        ]) => {
          const transferInfo = {
            fromPledgeAdmin,
            toPledgeAdmin,
            fromPledge,
            toPledge,
            toPledgeId: to,
            delegate,
            intendedProject,
            donation,
            amount,
            ts,
          };

          if (!donation)
            logger.error('missing donation for ->', JSON.stringify(transferInfo, null, 2));

          return this._doTransfer(transferInfo);
        },
      )
      .catch(logger.error);
  }

  /**
   * generate a mutation object used to update the current donation based off of the
   * given transferInfo
   *
   * @param transferInfo object containing information regarding the Transfer event
   * @private
   */
  createDonationMutation(transferInfo) {
    const {
      toPledgeAdmin,
      toPledge,
      toPledgeId,
      delegate,
      intendedProject,
      donation,
      amount,
      ts,
    } = transferInfo;

    const status = getDonationStatus(toPledge, toPledgeAdmin, !!intendedProject, !!delegate);

    const mutation = {
      amount,
      paymentStatus: pledgeState(toPledge.pledgeState),
      owner: toPledge.owner,
      ownerId: toPledgeAdmin.typeId,
      ownerType: toPledgeAdmin.type,
      intendedProject: toPledge.intendedProject,
      pledgeId: toPledgeId,
      commitTime: toPledge.commitTime > 0 ? new Date(toPledge.commitTime * 1000) : ts, // * 1000 is to convert evm ts to js ts
      status,
    };

    // intendedProject logic

    if (intendedProject) {
      Object.assign(mutation, {
        intendedProjectId: intendedProject.typeId,
        intendedProjectType: intendedProject.type,
      });
    }

    if (!intendedProject && donation.intendedProject) {
      delete mutation.intendedProject;

      Object.assign(mutation, {
        $unset: {
          intendedProject: true,
          intendedProjectId: true,
          intendedProjectType: true,
        },
      });
    }

    // delegate logic

    if (delegate) {
      Object.assign(mutation, {
        delegate: delegate.id,
        delegateId: delegate.typeId,
      });
    }

    // withdraw logic

    // if the pledgeState === 'Paying', this means that the owner is withdrawing and the delegates can no longer
    // delegate the pledge, so we drop them
    if ((!delegate || toPledge.pledgeState === '1') && donation.delegate) {
      Object.assign(mutation, {
        $unset: {
          delegate: true,
          delegateId: true,
          delegateType: true,
        },
      });
    }

    // if the toPledge is paying or paid and the owner is a milestone, then
    // we need to update the milestones status
    if (['1', '2'].includes(toPledge.pledgeState) && toPledgeAdmin.type === 'milestone') {
      this.app.service('milestones').patch(toPledgeAdmin.typeId, {
        status: toPledge.pledgeState === '1' ? 'Paying' : 'Paid',
        mined: true,
      });
    }

    return mutation;
  }

  _doTransfer(transferInfo) {
    const donations = this.app.service('donations');
    const {
      fromPledge,
      fromPledgeAdmin,
      toPledgeAdmin,
      toPledge,
      toPledgeId,
      delegate,
      intendedProject,
      donation,
      amount,
      ts,
    } = transferInfo;

    if (donation.amount === amount) {
      // this is a complete pledge transfer
      const mutation = this.createDonationMutation(transferInfo);

      // TODO fix the logic here so it sends the correct notifications
      // if (mutation.status === 'committed' || mutation.status === 'waiting' && delegate) {
      //
      //   if (donation.ownerEntity.email) {
      //     // send a receipt to the donor, if donor isn't anonymous
      //     Notifications.donation(this.app, {
      //       recipient: donation.ownerEntity.email,
      //       user: donation.ownerEntity.name,
      //       txHash: donation.txHash,
      //       donationType: toPledgeAdmin.type, // dac / campaign / milestone
      //       donatedToTitle: toPledgeAdmin.admin.title,
      //       amount: donation.amount
      //     });
      //   }
      //
      //   /**
      //    * send a notification to the admin of the dac / campaign / milestone
      //    **/
      //
      //   // if this is a DAC or a campaign, then the donation needs delegation
      //   if(toPledgeAdmin.type === 'campaign' || mutation.status === 'waiting') {
      //     let donatedToTitle;
      //     if (toPledgeAdmin.type === 'campaign') {
      //       donatedToTitle = toPledgeAdmin.admin.title;
      //     } else {
      //       donatedToTitle = donation.delegateEntity.title;
      //     }
      //
      //     Notifications.delegationRequired(this.app, {
      //       recipient: toPledgeAdmin.admin.email,
      //       user: toPledgeAdmin.admin.name,
      //       txHash: donation.txHash,
      //       donationType: toPledgeAdmin.type, // dac / campaign
      //       donatedToTitle: toPledgeAdmin.admin.title,
      //       amount: donation.amount
      //     });
      //   } else if (toPledgeAdmin.type === 'milestone') {
      //     // if this is a milestone then no action is required
      //     Notifications.donationReceived(this.app, {
      //       recipient: toPledgeAdmin.admin.email,
      //       user: toPledgeAdmin.admin.name,
      //       txHash: donation.txHash,
      //       donationType: toPledgeAdmin.type, // milestone
      //       donatedToTitle: toPledgeAdmin.admin.title,
      //       amount: donation.amount
      //     });
      //   }
      // }

      return donations
        .patch(donation._id, mutation)
        .then(() => this.trackDonationHistory(transferInfo));
    }
    // this is a split

    // update the current donation. only change is the amount
    const updateDonation = () => {
      const a = toBN(donation.amount)
        .sub(toBN(amount))
        .toString();

      const status =
        amount === '0'
          ? 'paid'
          : getDonationStatus(
              fromPledge,
              fromPledgeAdmin,
              donation.intendedProject && donation.intendedProject !== '0',
              !!donation.delegate,
            );

      return donations.patch(donation._id, {
        status,
        amount: a,
      });
    };

    // TODO create a donation model that copies the appropriate data
    // create a new donation
    const newDonation = Object.assign({}, donation, this.createDonationMutation(transferInfo));

    delete newDonation._id;
    delete newDonation.giver;
    delete newDonation.ownerEntity;
    delete newDonation.requiredConfirmations;
    delete newDonation.confirmations;

    const createDonation = () => donations.create(newDonation);

    return Promise.all([updateDonation(), createDonation()]).then(([updated, created]) =>
      this.trackDonationHistory(Object.assign({}, transferInfo, { toDonation: created })),
    );
  }

  trackDonationHistory(transferInfo) {
    const donationsHistory = this.app.service('donations/history');
    const {
      fromPledgeAdmin,
      toPledgeAdmin,
      fromPledge,
      toPledge,
      toPledgeId,
      delegate,
      intendedProject,
      donation,
      toDonation,
      amount,
      ts,
    } = transferInfo;

    const isNewDonation = () =>
      !toDonation &&
      fromPledge.oldPledge === '0' &&
      (toPledgeAdmin.type !== 'giver' || toPledge.nDelegates === '1') &&
      toPledge.intendedProject === '0';
    const isCommittedDelegation = () =>
      !toDonation &&
      fromPledge.intendedProject !== '0' &&
      fromPledge.intendedProject === toPledge.owner;
    const isCampaignToMilestone = () =>
      !toDonation && fromPledgeAdmin.type === 'campaign' && toPledgeAdmin.type === 'milestone';

    const history = {
      ownerId: toPledgeAdmin.typeId,
      ownerType: toPledgeAdmin.type,
      amount,
      txHash: donation.txHash,
      donationId: donation._id,
      giverAddress: donation.giverAddress,
    };

    if (delegate) {
      Object.assign(history, {
        delegateType: delegate.type,
        delegateId: delegate.typeId,
      });
    }

    // new donations & committed delegations
    if (
      toPledge.pledgeState === '0' &&
      (isNewDonation() || isCommittedDelegation() || isCampaignToMilestone())
    ) {
      // TODO remove this if statement one we handle all scenarios
      return donationsHistory.create(history);
    }

    // regular transfer
    if (toPledge.pledgeState === '0' && toDonation) {
      Object.assign(history, {
        donationId: toDonation._id,
        fromDonationId: donation._id,
        fromOwnerId: fromPledgeAdmin.typeId,
        fromOwnerType: fromPledgeAdmin.type,
      });
      return donationsHistory.create(history);
    }

    // if (toPledge.paymentStatus === 'Paying' || toPledge.paymentStatus === 'Paid') {
    //   // payment has been initiated/completed in vault
    //   return donationsHistory.create({
    //     status: (toPledge.paymentStatus === 'Paying') ? 'Payment Initiated' : 'Payment Completed',
    //     createdAt: ts,
    //   }, { donationId: donation._id });
    // }

    // canceled payment from vault

    // vetoed delegation
  }

  /**
   * fetches the ts for the given blockNumber.
   *
   * caches the last 50 ts
   *
   * first checks if the ts is in the cache.
   * if it misses, we fetch the block using web3 and cache the result.
   *
   * if we are currently fetching a given block, we will not fetch it twice.
   * instead, we resolve the promise after we fetch the ts for the block.
   *
   * @param blockNumber the blockNumber to fetch the ts of
   * @return Promise with a single ts value
   * @private
   */
  getBlockTimestamp(blockNumber) {
    if (this.blockTimes[blockNumber]) return Promise.resolve(this.blockTimes[blockNumber]);

    // if we are already fetching the block, don't do it twice
    if (this.fetchingBlocks[blockNumber]) {
      return new Promise(resolve => {
        // attach a listener which is executed when we get the block ts
        this.fetchingBlocks[blockNumber].push(resolve);
      });
    }

    this.fetchingBlocks[blockNumber] = [];

    return this.web3.eth.getBlock(blockNumber).then(block => {
      const ts = new Date(block.timestamp * 1000);

      this.blockTimes[blockNumber] = ts;

      // only keep 50 block ts cached
      if (Object.keys(this.blockTimes).length > 50) {
        Object.keys(this.blockTimes)
          .sort((a, b) => b - a)
          .forEach(key => delete this.blockTimes[key]);
      }

      // execute any listeners for the block
      this.fetchingBlocks[blockNumber].forEach(resolve => resolve(ts));
      delete this.fetchingBlocks[blockNumber];

      return ts;
    });
  }
}

export default Pledges;
