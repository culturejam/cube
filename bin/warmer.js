'use strict';

var cube    = require("../"),
    warmer  = cube.warmer(require('./warmer-config'));

warmer.start();
