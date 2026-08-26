module.exports = {
  apps: [
    { name: "dilee-api", cwd: __dirname, script: "./scripts/pm2-api-start.sh", interpreter: "/bin/bash", autorestart: true, watch: false },
    { name: "dilee-web", cwd: __dirname, script: "./scripts/pm2-web-start.sh", interpreter: "/bin/bash", autorestart: true, watch: false },
  ],
};
