/** Startup diagnostics are an output allowlist, not a best-effort secret scrubber.
 * Never serialize an exception, stack, cause, path, provider body or environment value.
 */
export type BackendStartupStage = 'configuration' | 'runtime' | 'settings' | 'storage' | 'services';
export class BackendStartupError extends Error {
  constructor(readonly stage: BackendStartupStage, cause: unknown) {
    super('Backend startup failed', { cause });
    this.name = 'BackendStartupError';
  }
}
const reasons = new Map<string, readonly [string, string]>([
  ['Explicit trial configuration required', ['configuration_required', '需要显式指定本地配置与激活文件。']],
  ['试用配置尚未就绪，请等待集成后的可运行版本。', ['configuration_unavailable', '配置或激活文件缺失、不可读或格式无效。']],
  ['试用配置已变化，需重新完成集成检查。', ['configuration_changed', '配置与激活记录的哈希不一致，请重新完成集成检查。']],
  ['试用真实模型尚未启用。', ['activation_inactive', '激活记录无效或尚未启用。']],
  ['试用阶段与配置不匹配。', ['activation_mismatch', '激活阶段与配置不匹配。']],
  ['试用配置文件无法读取。', ['invalid_json', '配置 JSON 格式无效。']],
  ['模型服务地址不在已登记供应商范围。', ['model_not_registered', '模型服务地址未登记或与型号不匹配。']],
  ['DeepSeek文本需要当前登记的Flash型号和保守计费边界。', ['model_not_registered', '模型型号或计费边界未登记。']],
  ['这个型号尚未登记适配能力和费用边界，不能应用。', ['model_not_registered', '管理设置中的模型型号或计费边界未登记。']],
  ['型号和服务地址不匹配。', ['model_not_registered', '管理设置中的型号与服务地址不匹配。']],
  ['凭据须使用项目外的受限文件。', ['credential_configuration_invalid', '凭据文件位置不符合本地访问限制。']],
  ['请选择已登记的同供应商凭据。', ['credential_configuration_invalid', '凭据未登记或与供应商不匹配。']],
  ['Unknown credential', ['credential_configuration_invalid', '凭据未登记。']],
  ['Unknown credential reference', ['credential_configuration_invalid', '凭据引用未登记。']],
  ['试用程序文件缺失或已变化，请使用集成后的同一版本。', ['runtime_integrity_failed', '已登记的运行文件缺失、不可读或指纹不一致。']],
  ['Invalid settings history', ['settings_invalid', '管理设置历史格式无效。']],
  ['Invalid settings revision', ['settings_invalid', '管理设置修订记录无效。']],
]);
const systemReasons = new Map<string, readonly [string, string]>([
  ['ENOENT', ['file_not_found', '启动所需的本地文件不存在。']],
  ['EACCES', ['permission_denied', '无法访问启动所需的本地资源。']],
  ['EPERM', ['permission_denied', '系统拒绝访问启动所需的本地资源。']],
  ['EEXIST', ['resource_exists', '启动资源已存在；请检查是否有仍在运行的后端。']],
  ['EADDRINUSE', ['address_in_use', '本地服务地址已被占用。']],
  ['ENOSPC', ['storage_full', '本地存储空间不足。']],
]);
export function formatBackendStartupFailure(error: unknown): string {
  let stage: BackendStartupStage | 'startup' = 'startup';
  let kind = 'unknown', reason = 'unexpected_error', detail = '启动出现未分类错误；未记录原始异常内容。';
  let code: string | undefined;
  try {
    if (error instanceof BackendStartupError) {
      const reportedStage = error.stage;
      if (['configuration','runtime','settings','storage','services'].includes(reportedStage)) stage = reportedStage;
      error = error.cause;
    }
    if (error instanceof Error) {
      // Names/codes are untrusted too: only exact, known tokens can leave this boundary.
      const name = error.name;
      kind = ['Error','TypeError','RangeError','SyntaxError','TrialNotReadyError','ManagementError','RegisteredVoiceError'].includes(name) ? name : 'Error';
      const known = reasons.get(error.message);
      const systemCode = (error as NodeJS.ErrnoException).code;
      if (known) [reason, detail] = known;
      else if (error instanceof SyntaxError) { reason = 'invalid_json'; detail = '本地 JSON 数据格式无效。'; }
      else if (kind === 'TrialNotReadyError') { reason = 'configuration_invalid'; detail = '配置未满足已登记的运行约束。'; }
      else if (kind === 'ManagementError') { reason = 'settings_invalid'; detail = '管理设置未满足当前运行约束。'; }
      else if (kind === 'RegisteredVoiceError') { reason = 'voice_registry_invalid'; detail = '本地音色登记无效或与配置不匹配。'; }
      if (typeof systemCode === 'string' && systemReasons.has(systemCode)) {
        code = systemCode;
        if (!known) [reason, detail] = systemReasons.get(systemCode)!;
      }
    }
  } catch { /* A throwing getter/Proxy must not break the failure reporter. */ }
  return 'backend_startup_failure ' + JSON.stringify({ stage, kind, reason, detail, ...(code ? {code} : {}) }) + '\n';
}
