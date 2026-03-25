import { z } from 'zod';

// Task schemas
export const createTaskSchema = z.object({
  project_id: z.string().min(1),
  title: z.string().min(1).max(500),
  description: z.string().max(10000).nullable().optional(),
  status: z.enum(['todo', 'in_progress', 'waiting', 'done', 'cancelled']).default('todo'),
  priority: z.enum(['critical', 'high', 'medium', 'low']).default('medium'),
  assignee: z.string().nullable().optional(),
  due_date: z.string().nullable().optional(),
  blocked_by: z.array(z.string()).default([]),
  parent_id: z.string().nullable().optional(),
  source: z.enum(['manual', 'agent', 'webhook', 'import']).default('agent'),
  tags: z.array(z.string()).default([]),
  notes: z.string().max(50000).nullable().optional(),
  attachments: z.array(z.any()).default([]),
});

export const updateTaskSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(10000).nullable().optional(),
  status: z.enum(['todo', 'in_progress', 'waiting', 'done', 'cancelled']).optional(),
  priority: z.enum(['critical', 'high', 'medium', 'low']).optional(),
  assignee: z.string().nullable().optional(),
  due_date: z.string().nullable().optional(),
  blocked_by: z.array(z.string()).optional(),
  parent_id: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  notes: z.string().max(50000).nullable().optional(),
  attachments: z.array(z.any()).optional(),
  revision: z.number().int().positive(),
});

// Project schemas
export const createProjectSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(10000).nullable().optional(),
  status: z.enum(['active', 'paused', 'archived']).default('active'),
  owner_agent_id: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
  tags: z.array(z.string()).default([]),
  settings: z.record(z.any()).default({}),
});

export const updateProjectSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(10000).nullable().optional(),
  status: z.enum(['active', 'paused', 'archived']).optional(),
  owner_agent_id: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  settings: z.record(z.any()).optional(),
  revision: z.number().int().positive(),
});

export type CreateTask = z.infer<typeof createTaskSchema>;
export type UpdateTask = z.infer<typeof updateTaskSchema>;
export type CreateProject = z.infer<typeof createProjectSchema>;
export type UpdateProject = z.infer<typeof updateProjectSchema>;
