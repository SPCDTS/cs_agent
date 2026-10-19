/** 初始化环境脱敏规则后公开日志接口；日志出口与脱敏核心不反向依赖此门面。 */
import './redact.js';
export { log, logBuffer, setLogLevel, type LogLine } from './log-core.js';
