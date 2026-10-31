import { z } from 'zod';

export const MemoryCategory = z.enum(['personal', 'project', 'operational', 'semantic', 'episodic', 'procedural']);
export type MemoryCategory = z.infer<typeof MemoryCategory>;

export type Memory = {
  id: string;
  category: MemoryCategory;
  title: string;
  content: string;
  source: string;
  confidence: number;
  tags: string[];
  syncable: boolean;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  lastAccessedAt: string | null;
};
