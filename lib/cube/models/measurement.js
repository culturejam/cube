'use strict';

var metalog = require('../metalog'),
    Model   = require('../core_ext/model'),
    reduces = require('../reduces'),
    Metric  = require('./metric'),
    Event   = require('./event'),
    _       = require('underscore'),
    config  = require('../../../config/cube'),
    compute = {constant: constant, binary: binary, unary: unary},
    setImmediate = require("../set-immediate"),
    queueByName  = {};

function isGrouped(expression){
  if (expression.type && expression.group){
    expression.group.type   = expression.type;
    expression.group.filter = expression.filter;
    return expression.group;
  }
  if (expression.op) return (isGrouped(expression.left) || isGrouped(expression.right));
  return;
}

function Measurement(expression, start, stop, tier){
  // Round the start/stop to the tier edges
  this.expression = expression;
  this.start       = start;
  this.stop        = stop;
  this.tier        = tier;
  this.flavor      = (expression.op ? 'binary' : (expression.type ? 'unary' : 'constant'));
  this.isPyramidal = expression.type && reduces[expression.reduce].pyramidal;
  this.isGrouped   = isGrouped(expression);

  this.eventize();
}

Model.modelize(Measurement);

Measurement.prototype.report = function report(){
  return { flavor: this.flavor, tier: this.tier.key, start: this.tier.bin(this.start), stop: this.tier.bin(this.stop), expr: (this.expression.op||this.expression.source||this.expression.value()) };
};

// Computes the metric for the given expression for the time interval from
// start (inclusive) to stop (exclusive). The time granularity is determined
// by the specified tier, such as daily or hourly. The callback is invoked
// repeatedly for each metric value. The values may be out of order due
// to partial cache hits.
Measurement.prototype.measure = function measure(db, callback) {
  var _this = this;
  if (this.isGrouped && !Array.isArray(this.isGrouped.groups)) {
    Event.groups(db, this, function(error, group_names){
      handle(error);
      _this.isGrouped.groups = group_names.sort();
      compute[_this.flavor].call(_this, db, callback);
    });
  } else {
    compute[this.flavor].call(this, db, callback);
  }
};

// Computes a constant expression like the "7" in "x * 7"
function constant(db, callback) {
  var _this = this, value = this.expression.value();
  walk(this.start, this.stop, this.tier, function(time){
    callback(new Metric({time: time, value: value}, _this));
  });
  this.emit('complete');
};

// Serializes a unary expression for computation.
function unary(db, callback) {
  var self            = this,
      total_remaining = 0,
      remaining       = 0,
      time0           = Date.now(),
      name            = this.expression.source,
      queue           = queueByName[name];

  // Compute the expected number of values.
  walk(this.start, this.stop, this.tier, function(time){ ++remaining; });

  // If no results were requested, return immediately.
  if (!remaining) return this.emit('complete');

  total_remaining = remaining;
  if(this.isGrouped) total_remaining *= (this.isGrouped.groups.length || 1);

  // Add this task to the appropriate queue.
  if (queue) queue.next = task;
  else setImmediate(task);
  queueByName[name] = task;

  function task() {
    function onMetric(metric){
      callback(metric);
      if (--total_remaining <= 0) {
        self.emit('complete');
        if (task.next) setImmediate(task.next);
        else delete queueByName[name];

        // Record how long it took us to compute as an event!
        var time1 = Date.now();
        metalog.event("cube_compute", {
          expression: self.expression.source,
          ms: time1 - time0
        });
      }
    }

    function nextGroup(prev_group){
      var query_measurement = new Measurement(_.clone(self.expression), self.start, self.stop, self.tier),
          group_idx         = self.isGrouped.groups.indexOf(prev_group) + 1,
          group_name        = self.isGrouped.groups[group_idx],
          group_remaining   = remaining;

      // Stop there if it is the last group, unless we are in the 1st pass,
      // which would mean we have no group at all, so let's compute empty values.
      if (group_idx >= self.isGrouped.groups.length && arguments.length) return;

      query_measurement.group = group_name;

      findOrComputeUnary.call(query_measurement, db, function(metric){
        onMetric(metric);
        if(!--group_remaining) nextGroup(group_name);
      });
    }

    if (self.expression.group) {
      nextGroup();
    } else {
      findOrComputeUnary.call(self, db, onMetric);
    }
  }
}

// Finds or computes a unary (primary) expression.
function findOrComputeUnary(db, callback) {
  var expression  = this.expression,
      group_name  = this.group,
      isGrouped   = 'group' in this,
      map         = expression.value,
      reduce      = reduces[expression.reduce],
      measurement = this;

  find(measurement, callback);

  // The metric is computed recursively, reusing the above variables.
  function find(measurement, callback) {
    var start  = measurement.start,
        stop   = measurement.stop,
        tier   = measurement.tier,
        compute = ((tier.next) ? computePyramidal : computeFlat),
        time    = start;

    // Query for the desired metric in the cache.
    Metric.find(db, measurement, foundMetrics);

    // Immediately report back whatever we have. If any values are missing,
    // merge them into contiguous intervals and asynchronously compute them.
    function foundMetrics(error, metric) {
      handle(error);
      if (metric) {
        callback(metric);                                    // send back value for this timeslot
        if (time < metric.time) compute(time, metric.time);  // recurse from last value seen up to this timeslot
        time = tier.step(metric.time);                       // update the last-observed timeslot
      } else {
        if (time < stop) compute(time, stop);                // once last row is seen, compute rest of range
      }
    }

    // Group metrics from the next tier.
    function computePyramidal(start, stop) {
      var query_measurement = new Measurement(expression, start, stop, tier.next),
          bins = {};

      if(isGrouped) query_measurement.group = group_name;

      find(query_measurement, function(metric) {
        var value = metric.value, time = metric.time, values = metric.values;

        var bin  = bins[time = tier.floor(time)] || (bins[time] = {size: tier.size(time), values: []});

        if (reduce.pyramidal) bin.values.push(value);
        else bin.values = bin.values.concat(values||[]);

        if (!--bin.size) {
          var metric;
          if (isGrouped) {
            metric = new Metric({time: time, value: reduce(bin.values), group: group_name}, measurement, bin.values)
          } else {
            metric = new Metric({time: time, value: reduce(bin.values)}, measurement, bin.values)
          }

          if (metric.value || metric.value === 0 || metric.value === undefined) metric.save(db, handle);
          callback(metric);
          delete bins[time];
        }
      });
    }

    // Group raw events. Unlike the pyramidal computation, here we can control
    // the order in which rows are returned from the database. Thus, we know
    // when we've seen all of the events for a given time interval.
    function computeFlat(start, stop) {
      var horizons = config.get('horizons'), pastHorizon = {
        is: 'past_horizon',
        tier: tier,
        expression: expression.source
      };

      // Reset start time to calculation horizon if requested time span goes past it
      if (horizons && tier.floor(start) < new Date(new Date() - horizons.calculation)){
        var old_start = start,
            start = tier.step(tier.floor(new Date(new Date() - horizons.calculation)))

        pastHorizon.start = { was: old_start, updated_to: start };
      }

      // Reset stop time to calculation horizon if requested time span goes past it
      if (horizons && tier.floor(stop) < new Date(new Date() - horizons.calculation)){
        var old_stop = stop,
            stop = tier.step(tier.floor(new Date(new Date() - horizons.calculation)))

        pastHorizon.stop = { was: old_stop, updated_to: stop };
      }

      if (old_start || old_stop) {
        metalog.info('cube_compute', pastHorizon);
      }

      var time = start, values = [];

      if (isGrouped && group_name === undefined) {
        // We do have grouping enabled, but no group at all, so answer right away with empty metrics.
        return process();
      }

      var query_measurement = new Measurement(expression, start, stop, tier);

      if (group_name) query_measurement.group = group_name;

      function flat_callback(time, values){
        var value = (values.length ? reduce(values) : reduce.empty),
            metric;
        if (isGrouped) {
          metric = new Metric({ time: time, value: value, group: group_name }, measurement, values);
        } else {
          metric = new Metric({ time: time, value: value }, measurement, values);
        }
        callback(metric);
        if (metric.value || metric.value === 0 || metric.value === undefined) metric.save(db, handle);
      }

      function process(error, event){
        handle(error);

        if (event) {
          var then = tier.floor(event.time);

          if (time < then) {
            flat_callback(time, values);
            while ((time = tier.step(time)) < then) flat_callback(time, []);
            values = [map(event.to_wire())];
          } else {
            values.push(map(event.to_wire()));
          }
        } else {
          flat_callback(time, values);
          while ((time = tier.step(time)) < stop) flat_callback(time, []);
        }
      }

      Event.find(db, query_measurement, process);
    }
  }
}

// Computes a binary expression by merging two subexpressions
//
// "sum(req) - sum(resp)" will op ('-') the result of unary "sum(req)" and
// unary "sum(resp)". We don't know what order they'll show up in, so if say
// the value for left appears first, it parks that value as left[time], where
// the result for right will eventually find it.
function binary(db, callback) {
  var self    = this, expression = this.expression, value;
  var left    = new Measurement(expression.left,  this.start, this.stop, this.tier),
      right   = new Measurement(expression.right, this.start, this.stop, this.tier),
      groups, grouped_measurement = left, other_measurement = right;

  left.left = true;
  right.right = true;

  function complete(measurement, other){
    return function(){
      var time = self.stop;
      if (time in other){
        self.emit("complete");
      } else {
        measurement[time] = undefined;
      }
    }
  }

  function measure(measurement, other){
    return function(metric){
      var time = metric.time, value = metric.value, isGrouped = 'group' in metric,
          group = metric.group, left_value, right_value;

      if (time in other) {
        left_value  = measurement.left  ? value : other[time];
        right_value = measurement.right ? value : other[time];
        if (isGrouped) {
          metric = { time: time, value: expression.op(left_value, right_value), group: group };
        } else {
          metric = { time: time, value: expression.op(left_value, right_value) };
        }
        callback(new Metric(metric));
      } else {
        measurement[time] = value;
      }
    }
  }

  if(this.isGrouped){
    groups = this.isGrouped.groups;
    if(right.isGrouped){
      grouped_measurement = right;
      other_measurement = left;
    }

    other_measurement.on("complete", function(){
      complete(other_measurement, grouped_measurement)();
      grouped_measurement.measure(db, measure(grouped_measurement, other_measurement));
    });
    grouped_measurement.on("complete", complete(grouped_measurement, other_measurement));
    other_measurement.measure(db, measure(other_measurement, grouped_measurement));
  } else {
    left.on("complete", complete(left, right));
    right.on("complete", complete(right, left));

    left.measure(db, measure(left, right));
    right.measure(db, measure(right, left));
  }
};

// execute cb on each interval from t1 to t2
function walk(t1, t2, tier, cb){
  while (t1 < t2) {
    cb(t1, t2);
    t1 = tier.step(t1);
  }
}

function handle(error) {
  if (!error) return;
  metalog.error('measurement', error);
  throw error;
}

module.exports = Measurement;
