/** Detecta dados sensíveis que não devem ser memorizados automaticamente. */
export function detectSensitive(text: string): string[] {
  const found: string[] = [];
  if (/\b(senha|password|passwd|pwd)\s*[:=é]\s*\S+/i.test(text)) found.push('senha');
  if (/\b(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|xox[bp]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.)/.test(text)) found.push('token/chave de API');
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) found.push('chave privada');
  if (/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/.test(text) && /cpf/i.test(text)) found.push('CPF');
  for (const m of text.matchAll(/\b(?:\d[ -]?){13,19}\b/g)) if (luhn(m[0].replace(/\D/g, ''))) found.push('cartão de crédito');
  return [...new Set(found)];
}

function luhn(num: string) {
  if (num.length < 13) return false;
  let sum = 0;
  let alt = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let n = Number(num[i]);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}
