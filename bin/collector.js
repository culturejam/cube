'use strict';

var cube = require("../"),
    server = cube.server(require('./collector-config'));

server
  .use(cube.collector.register)
  .start();
