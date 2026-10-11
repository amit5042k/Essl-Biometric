'use strict';

// Startup file for hosts that load the app with require() instead of running it
// directly (cPanel "Setup Node.js App" / Phusion Passenger on GoDaddy shared hosting).
require('./src/server').start();
