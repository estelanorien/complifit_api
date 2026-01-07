module.exports = {
  apps: [
    {
      name: 'vitality-api',
      script: 'dist/server.js',

      // Cluster mode for better performance
      instances: 1,
      exec_mode: 'fork',

      // Environment variables
      env: {
        NODE_ENV: 'development',
        PORT: 8080
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 8080
      },
      max_memory_restart: '1800M',  // 2GB'nin %90'ı

      // Logging
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,

      // Auto restart configuration
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',

      // Watch mode (disable in production)
      watch: false,
      ignore_watch: ['node_modules', 'logs', 'dist'],

      // Graceful shutdown
      kill_timeout: 5000,
      listen_timeout: 3000,

      // Source map support
      source_map_support: true,

      // Cron restart (optional - restart every day at 3 AM)
      cron_restart: '0 3 * * *',
      kill_timeout: 5000,
      listen_timeout: 3000,
      // Instance variables
      instance_var: 'INSTANCE_ID'
    }
  ],

  // Deployment configuration (optional)
  deploy: {
    production: {
      user: 'deploy',
      host: 'your-server-ip',
      ref: 'origin/main',
      repo: 'git@github.com:username/vitality-api.git',
      path: '/var/www/vitality-api',
      'post-deploy': 'npm install && npm run build && pm2 reload ecosystem.config.js --env production',
      'pre-setup': 'apt-get install git'
    }
  }
};

