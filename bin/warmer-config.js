module.exports = {
  mongodb: {
    'mongo-host': '127.0.0.1',
    'mongo-port': 27017,
    'mongo-database': 'cube',
    'mongo-username': null,
    'mongo-password': null,
    'mongo-server-options': {
      auto_reconnect: true,
      poolSize: 8,
      socketOptions: {
        noDelay: true
      }
    },

    'mongo-metrics': {
      autoIndexId: true,
      capped: false,
      safe: false
    },

    'mongo-events': {
      autoIndexId: true,
      capped: true,
      size: 1e9,
      safe: false
    },

    'separate-events-database': true,

    'authentication-collection': 'users'
  },
  horizons: {
    'calculation': 1000 * 60 * 60 * 2, // 2 hours
    'invalidation': 1000 * 60 * 60 * 1, // 1 hour
    'forced_metric_expiration': 1000 * 60 * 60 * 24 * 7, // 7 days
  },
  'collectd-mappings': {
    'snmp': {
      'if_octets': 'interface',
      'disk_octets': 'disk',
      'swap_io': 'swap',
      'swap': 'swap'
    }
  },

  warmer: {
    'warmer-interval': 1000 * 30,
    'warmer-tier': 1000 * 10
  }
};
