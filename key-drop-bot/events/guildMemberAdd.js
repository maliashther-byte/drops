'use strict';

const { recordInvitedMember } = require('../utils/inviteTracker');
const logger = require('../utils/logger');

module.exports = {
  name: 'guildMemberAdd',
  async execute(member) {
    try {
      await recordInvitedMember(member);
    } catch (error) {
      logger.error('invite_join_record_failed', {
        guildId: member.guild.id,
        userId: member.id,
        error: error.message,
      });
    }
  },
};
