function getEnv(name: keyof NodeJS.ProcessEnv, required = true): string {
  const value = process.env[name];
  if (!value && required) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value!;
}

export const configData = {
  NODE_ENV: getEnv('NODE_ENV'),
  MONGO_URI: getEnv('MONGO_URI'),
  PORT: getEnv('PORT', false) || '3000',
  // API_KEY: getEnv('API_KEY', false) || '',
  CLIENT_URL: getEnv('CLIENT_URL', false) || 'http://localhost:3000',
  JWT_SECRET: getEnv('JWT_SECRET', false) || '',
  COOKIE_EXPIRY: getEnv('COOKIE_EXPIRY', false) || '3',
  JWT_EXPIRY: getEnv('JWT_EXPIRY', false) || '1d',
};
