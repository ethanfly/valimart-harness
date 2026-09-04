<?xml version="1.0" encoding="utf-8"?>
<!-- WinSW 服务定义；由 init.mjs 在安装时渲染，占位符：INSTDIR / DATA_DIR / LOG_DIR -->
<service>
  <id>TheDivaGateway</id>
  <name>THE DIVA 公司网关</name>
  <description>THE DIVA 企业交付工作台的公司网关：公司账号与网关令牌、模型代理与按人记账、任务验收流、公司盘。</description>
  <executable>{{INSTDIR}}\runtime\node.exe</executable>
  <arguments>"{{INSTDIR}}\server\src\index.js"</arguments>
  <workingdirectory>{{INSTDIR}}\server</workingdirectory>
  <env name="DESK_GATEWAY_DATA" value="{{DATA_DIR}}"/>
  <env name="NODE_ENV" value="production"/>
  <startmode>Automatic</startmode>
  <onfailure action="restart" delay="10 sec"/>
  <onfailure action="restart" delay="30 sec"/>
  <resetfailure>1 hour</resetfailure>
  <stoptimeout>15 sec</stoptimeout>
  <logpath>{{LOG_DIR}}</logpath>
  <log mode="roll-by-size">
    <sizeThreshold>10240</sizeThreshold>
    <keepFiles>8</keepFiles>
  </log>
</service>
