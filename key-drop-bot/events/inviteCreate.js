'use strict';

const { handleInviteCreate } = require('../utils/inviteTracker');

module.exports = {
  name: 'inviteCreate',
  execute(invite) {
    handleInviteCreate(invite);
  },
};
