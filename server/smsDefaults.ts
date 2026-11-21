import crypto from 'node:crypto';

export type Fast2SmsTemplatePurpose =
  | 'SERVICE_REQUEST'
  | 'LOGIN_OTP'
  | 'ACCOUNT_REGISTRATION'
  | 'PASSWORD_CHANGED'
  | 'TASK_COMPLETED'
  | 'PAYMENT_RECEIVED'
  | 'PORTAL_LOGIN_OTP';

export const FAST2SMS_TEMPLATE_PURPOSES: ReadonlyArray<{
  key: Fast2SmsTemplatePurpose;
  label: string;
}> = [
  { key: 'SERVICE_REQUEST', label: 'Service Request Registration' },
  { key: 'LOGIN_OTP', label: 'Login OTP Verification' },
  { key: 'ACCOUNT_REGISTRATION', label: 'Account Registration / User ID' },
  { key: 'PASSWORD_CHANGED', label: 'Password Change Notification' },
  { key: 'TASK_COMPLETED', label: 'Task Completion Notice' },
  { key: 'PAYMENT_RECEIVED', label: 'Payment Received Confirmation' },
  { key: 'PORTAL_LOGIN_OTP', label: 'Portal Login OTP' },
];

export interface DefaultFast2SmsGatewayConfig {
  apiKey: string;
  route: 'dlt' | 'dlt_manual' | 'otp' | 'q';
  senderId: string;
  templateId: string;
  templates: Record<Fast2SmsTemplatePurpose, string>;
}

const SEALED_DEFAULT_SMS_GATEWAY =
  'b11c8a067d6033e8ab30705f:2d80c194235e7de3fc033e8e10a41360:830194ac09f311a4407a0bb1ffe11417f8c522f5c43fad738ddfab488c65da0daa66d096048a4fc2f493444f47c346e2deec2cc8c7d24ea2b2af835a6e792add5b359a9cc7725df2fc86f862e631bb7526afb2e8865eb58f11b390297e86ca21523b8581427cdb27fba2912751e0c81dc55c4335d38f82f23b4cee64ad3466a8c80a4a26277901021a0607edd1c2c8227fc2c7e8434c9a2d8991658535b4646961ecfe988db6acefad19ceaa4de8e64c33931bb04a43b637db279f890da991350aeeb81a567859ce5d07ff3797c7765d06891dcb71e7225a360db9b8c1544e7f47383369e2d4560858b84d88acd7d9b81ac9a8bbbe9732bbefb02de07f1a16a7bf2d0a785a70b9617a170f682575288072a5ed037595e31da06f4d1050b38d2b2c2c64f61f766abaa3e45e4ddbf0c4b8f83b4d27af0966c69cb21231bb92abbc17ae5e10ac8b9437ea15eeef51';

let cachedDefaults: DefaultFast2SmsGatewayConfig | null | undefined;

export function getDefaultFast2SmsGatewayConfig(options?: {
  includeInTests?: boolean;
}): DefaultFast2SmsGatewayConfig | null {
  const isTestContext =
    process.env.NODE_ENV === 'test' || Boolean(process.env.NODE_TEST_CONTEXT);
  if (isTestContext && !options?.includeInTests) {
    return null;
  }
  if (process.env.DISABLE_DEFAULT_FAST2SMS === 'true') {
    return null;
  }
  if (cachedDefaults !== undefined) {
    return cachedDefaults;
  }
  try {
    const [ivHex, tagHex, dataHex] = SEALED_DEFAULT_SMS_GATEWAY.split(':');
    const key = crypto
      .createHash('sha256')
      .update('mun-computer-sms-gateway-seal-v1')
      .digest();
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(ivHex, 'hex')
    );
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(dataHex, 'hex')),
      decipher.final(),
    ]).toString('utf8');
    const parsed = JSON.parse(decrypted) as Partial<DefaultFast2SmsGatewayConfig>;
    if (parsed.apiKey && parsed.templateId) {
      const parsedTemplates = (parsed.templates || {}) as Partial<
        Record<Fast2SmsTemplatePurpose, string>
      >;
      const fallbackId = String(parsed.templateId).trim();
      const templates: Record<Fast2SmsTemplatePurpose, string> = {
        SERVICE_REQUEST: String(parsedTemplates.SERVICE_REQUEST || fallbackId).trim(),
        LOGIN_OTP: String(parsedTemplates.LOGIN_OTP || fallbackId).trim(),
        ACCOUNT_REGISTRATION: String(parsedTemplates.ACCOUNT_REGISTRATION || fallbackId).trim(),
        PASSWORD_CHANGED: String(parsedTemplates.PASSWORD_CHANGED || fallbackId).trim(),
        TASK_COMPLETED: String(parsedTemplates.TASK_COMPLETED || fallbackId).trim(),
        PAYMENT_RECEIVED: String(parsedTemplates.PAYMENT_RECEIVED || fallbackId).trim(),
        PORTAL_LOGIN_OTP: String(parsedTemplates.PORTAL_LOGIN_OTP || fallbackId).trim(),
      };
      cachedDefaults = {
        apiKey: parsed.apiKey,
        route: parsed.route || 'dlt',
        senderId: parsed.senderId || 'MUNCMP',
        templateId: fallbackId,
        templates,
      };
      return cachedDefaults;
    }
  } catch {
    // Ignore malformed default configuration
  }
  cachedDefaults = null;
  return null;
}
