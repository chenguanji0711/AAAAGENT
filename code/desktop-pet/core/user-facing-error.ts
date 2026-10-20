import { ProviderHttpError } from '../providers/transport.js';
/** Keep provider/engineering diagnostics out of the user's error bubble. */
export function userFacingError(error:unknown):string {
 if(error instanceof ProviderHttpError) {
   const code=error.providerCode?` · ${error.providerCode}`:'';
   const reason=error.providerCode==='AllocationQuota.FreeTierOnly'
     ? '免费额度用完即停已触发，请在百炼控制台核对剩余额度及节省计划。'
     : error.providerCode==='Arrearage'
       ? '阿里云账户欠费或余额不足，请在费用与成本核对账户可用额度；若账户正常，请核对 API Key 所属账号。'
     : error.status===401?'API Key 未通过认证，请在本机设置页检查凭据。'
     : error.status===403?'请检查模型权限、可用额度及账户状态。'
     : error.status===404?'所选模型或服务地址不可用，请核对型号和地域。'
     : error.status===429?'调用频率达到供应商限制，请稍后再试。'
     : error.status>=500?'供应商服务暂时异常，请稍后再试。'
     : '供应商拒绝了请求，请核对模型配置。';
   return `${error.operation==='tts'?'回复文字已保留，语音生成失败：':'模型调用失败：'}HTTP ${error.status}${code}。${reason}`;
 }
 const message=error instanceof Error?error.message:String(error);
 if(/MiniMax|audio hex/.test(message))return '回复文字已保留，但生成的语音未通过检查，这次没有播放声音。';
 if(/[\u3400-\u9fff]/.test(message))return message;
 if(/budget exhausted|budget cannot cover|reservation_exceeded|Budget is blocked/.test(message))return '剩余总预算不足以支付这次请求，请先查看费用记录。';
 if(/call limit|generation limit/.test(message))return '这次请求被旧试用配置拦住，请更新本地服务后再试。';
 if(/HTTP (401|403)/.test(message))return '模型服务没有接受当前凭据，请检查服务配置。';
 if(/HTTP 429/.test(message))return '模型服务暂时繁忙，请稍后再试。';
 if(/HTTP 5[0-9][0-9]/.test(message))return '模型服务暂时出错，请稍后再试。';
 if(/ASR|transcript/.test(message))return '这次语音转写没有完成，请重新说一次。';
 if(/scope|cancelled|Abort|stale/i.test(message))return '这次操作已取消。';
 if(/timeout|timed out/i.test(message))return '模型服务响应超时，请稍后再试。';
 if(/unknown.cost|Trial is stopped|not active/.test(message))return '服务暂时无法继续，请查看当前运行状态。';
 return '这一轮没有完成，请稍后再试。';
}
