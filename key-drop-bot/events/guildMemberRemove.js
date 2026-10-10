'use strict';

const { markInvitedMemberLeft } = require('../utils/inviteTracker');
const logger = require('../utils/logger');

module.exports = {
  name: 'guildMemberRemove',
  async execute(member) {
    try {
      await markInvitedMemberLeft(member);
    } catch (error) {
      logger.error('invite_leave_update_failed', {
        guildId: member.guild.id,
        userId: member.id,
        error: error.message,
      });
    }
  },
};
