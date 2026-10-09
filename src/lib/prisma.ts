import { PrismaClient } from '@prisma/client';
import { withoutStatementCache } from './prisma-url';

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

// No statement cache: the data-table adapter changes row tables at runtime (see prisma-url.ts).
export const prisma =
  globalForPrisma.prisma || new PrismaClient({ datasourceUrl: withoutStatementCache(process.env.DATABASE_URL) });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
