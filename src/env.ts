import { z } from 'zod';

export const envSchema = z.object({
  ENABLE_DISCORD: z.enum(['true', 'false']).default('false'),
  ENABLE_CLICKHOUSE: z.enum(['true', 'false']).default('false'),
  ENABLE_SERVER: z.enum(['true', 'false']).default('false'),
  PORT: z.coerce.number().default(3000),
});

export type Env = z.infer<typeof envSchema>;

const env: Env = (() => {
  try {
    return envSchema.parse(process.env);
  } catch (error) {
    const zodError = error as z.ZodError;
    console.error('❌ Invalid environment variables:');
    console.error(z.prettifyError(zodError));
    process.exit(1);
  }
})();

export default env;
