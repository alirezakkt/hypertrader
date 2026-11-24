module.exports = {
  apps: [{
    name: 'hyper-platform',
    script: 'server/index.js',
    cwd: '/opt/hyper',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    env: { NODE_ENV: 'production', PORT: 3000 },
    error_file: '/var/log/hyper/error.log',
    out_file: '/var/log/hyper/out.log',
  }]
};