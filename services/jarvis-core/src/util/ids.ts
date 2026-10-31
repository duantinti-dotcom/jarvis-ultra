import crypto from 'node:crypto';

export const newId = (prefix: string) => `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;
export const nowIso = () => new Date().toISOString();
export const sha256 = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest('hex');
