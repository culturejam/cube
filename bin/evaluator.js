'use strict';

var cube = require("../"),
    server = cube.server(require('./evaluator-config'));

server
  .use(cube.evaluator.register)
  .use(cube.visualizer.register)
  .start();
