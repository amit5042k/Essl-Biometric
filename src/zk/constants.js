'use strict';

// Command codes of the ZKTeco "standalone" protocol used by eSSL devices
// (Classic series: K21, K30, X990, MB160, ... and Orcus face/finger terminals)
// on TCP/UDP port 4370.
module.exports = Object.freeze({
  USHRT_MAX: 65535,

  CMD_CONNECT: 1000,
  CMD_EXIT: 1001,
  CMD_ENABLEDEVICE: 1002,
  CMD_DISABLEDEVICE: 1003,
  CMD_RESTART: 1004,
  CMD_POWEROFF: 1005,
  CMD_REFRESHDATA: 1013,
  CMD_GET_VERSION: 1100,
  CMD_AUTH: 1102,

  CMD_ACK_OK: 2000,
  CMD_ACK_ERROR: 2001,
  CMD_ACK_DATA: 2002,
  CMD_ACK_RETRY: 2003,
  CMD_ACK_REPEAT: 2004,
  CMD_ACK_UNAUTH: 2005,
  CMD_ACK_UNKNOWN: 0xffff,

  CMD_PREPARE_DATA: 1500,
  CMD_DATA: 1501,
  CMD_FREE_DATA: 1502,
  CMD_DATA_WRRQ: 1503,
  CMD_READ_BUFFER: 1504,

  CMD_DB_RRQ: 7,
  CMD_OPTIONS_RRQ: 11,
  CMD_OPTIONS_WRQ: 12,
  CMD_ATTLOG_RRQ: 13,
  CMD_CLEAR_DATA: 14,
  CMD_CLEAR_ATTLOG: 15,
  CMD_USER_WRQ: 8,
  CMD_USERTEMP_RRQ: 9,
  CMD_DELETE_USER: 18,
  CMD_GET_FREE_SIZES: 50,
  CMD_GET_TIME: 201,
  CMD_SET_TIME: 202,
  CMD_SAVE_USERTEMPS: 110,
  CMD_REG_EVENT: 500,

  FCT_FINGERTMP: 2,
  FCT_USER: 5,

  // TCP envelope magic: 0x5050 0x7d82 (little endian) followed by payload length
  MACHINE_PREPARE_DATA_1: 0x5050,
  MACHINE_PREPARE_DATA_2: 0x7d82,

  // Punch states reported by the terminal
  PUNCH_STATES: {
    0: 'Check-In',
    1: 'Check-Out',
    2: 'Break-Out',
    3: 'Break-In',
    4: 'OT-In',
    5: 'OT-Out',
    255: 'Unknown',
  },

  // Verification modes reported by the terminal
  VERIFY_TYPES: {
    0: 'Password',
    1: 'Fingerprint',
    2: 'Card',
    3: 'Password',
    4: 'Card',
    9: 'Card',
    15: 'Face',
    25: 'Palm',
  },

  USER_PRIVILEGE: { USER: 0, ADMIN: 14 },
});
