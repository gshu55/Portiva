export function requiresSavedCredentialRecovery(message: string) {
  return (
    message.includes("系统凭据库读取凭据失败") ||
    message.includes("系统凭据库任务执行失败") ||
    message.includes("读取已保存的 SSH 凭据超时") ||
    message.includes("未找到已保存的 SSH 密码") ||
    message.includes("Portiva 凭据主密钥") ||
    message.includes("Portiva 凭据密文") ||
    message.includes("Portiva 凭据解密") ||
    message.includes("SSH password authentication failed") ||
    message.includes("SSH private key authentication failed")
  );
}
