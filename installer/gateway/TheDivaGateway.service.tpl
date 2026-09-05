[Unit]
Description=valimart harness 公司网关
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User={{USER}}
Group={{USER}}
WorkingDirectory={{INSTDIR}}/server
Environment=NODE_ENV=production
Environment=DESK_GATEWAY_PACKAGED=1
Environment=DESK_GATEWAY_DATA={{DATA_DIR}}
ExecStart={{NODE}} {{INDEX}}
Restart=on-failure
RestartSec=10
StandardOutput=append:{{LOG_DIR}}/TheDivaGateway.out.log
StandardError=append:{{LOG_DIR}}/TheDivaGateway.err.log
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
