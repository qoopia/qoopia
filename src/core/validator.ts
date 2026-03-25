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

// Deal schemas
export const createDealSchema = z.object({
  project_id: z.string().min(1),
  name: z.string().min(1).max(500),
  address: z.string().max(500).nullable().optional(),
  status: z.enum(['active', 'paused', 'archived']).default('active'),
  asking_price: z.number().nullable().optional(),
  target_price: z.number().nullable().optional(),
  monthly_rent: z.number().nullable().optional(),
  lease_term_months: z.number().int().nullable().optional(),
  metadata: z.record(z.any()).default({}),
  documents: z.array(z.any()).default([]),
  timeline: z.array(z.any()).default([]),
  tags: z.array(z.string()).default([]),
  notes: z.string().max(50000).nullable().optional(),
  contact_ids: z.array(z.string()).optional(), // for deal_contacts join
});

export const updateDealSchema = z.object({
  name: z.string().min(1).max(500).optional(),
  address: z.string().max(500).nullable().optional(),
  status: z.enum(['active', 'paused', 'archived']).optional(),
  asking_price: z.number().nullable().optional(),
  target_price: z.number().nullable().optional(),
  monthly_rent: z.number().nullable().optional(),
  lease_term_months: z.number().int().nullable().optional(),
  metadata: z.record(z.any()).optional(),
  documents: z.array(z.any()).optional(),
  timeline: z.array(z.any()).optional(),
  tags: z.array(z.string()).optional(),
  notes: z.string().max(50000).nullable().optional(),
  contact_ids: z.array(z.string()).optional(),
  revision: z.number().int().positive(),
});

// Contact schemas
export const createContactSchema = z.object({
  name: z.string().min(1).max(200),
  role: z.string().max(200).nullable().optional(),
  company: z.string().max(200).nullable().optional(),
  email: z.string().email().nullable().optional(),
  phone: z.string().max(50).nullable().optional(),
  telegram_id: z.string().max(50).nullable().optional(),
  language: z.string().max(10).default('EN'),
  timezone: z.string().max(20).nullable().optional(),
  category: z.string().max(50).nullable().optional(),
  communication_rules: z.string().max(5000).nullable().optional(),
  tags: z.array(z.string()).default([]),
  notes: z.string().max(50000).nullable().optional(),
  project_ids: z.array(z.string()).optional(), // for contact_projects join
});

export const updateContactSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  role: z.string().max(200).nullable().optional(),
  company: z.string().max(200).nullable().optional(),
  email: z.string().email().nullable().optional(),
  phone: z.string().max(50).nullable().optional(),
  telegram_id: z.string().max(50).nullable().optional(),
  language: z.string().max(10).optional(),
  timezone: z.string().max(20).nullable().optional(),
  category: z.string().max(50).nullable().optional(),
  communication_rules: z.string().max(5000).nullable().optional(),
  tags: z.array(z.string()).optional(),
  notes: z.string().max(50000).nullable().optional(),
  project_ids: z.array(z.string()).optional(),
  revision: z.number().int().positive(),
});

// Finance schemas
export const createFinanceSchema = z.object({
  project_id: z.string().nullable().optional(),
  type: z.enum(['subscription', 'credit', 'investment', 'budget', 'purchase', 'acquisition']),
  name: z.string().min(1).max(200),
  amount: z.number(),
  currency: z.string().max(10).default('USD'),
  recurring: z.enum(['none', 'monthly', 'annual', 'biennial']).default('none'),
  status: z.enum(['active', 'trial', 'paused', 'cancelled']).default('active'),
  tags: z.array(z.string()).default([]),
  notes: z.string().max(50000).nullable().optional(),
});

export const updateFinanceSchema = z.object({
  project_id: z.string().nullable().optional(),
  type: z.enum(['subscription', 'credit', 'investment', 'budget', 'purchase', 'acquisition']).optional(),
  name: z.string().min(1).max(200).optional(),
  amount: z.number().optional(),
  currency: z.string().max(10).optional(),
  recurring: z.enum(['none', 'monthly', 'annual', 'biennial']).optional(),
  status: z.enum(['active', 'trial', 'paused', 'cancelled']).optional(),
  tags: z.array(z.string()).optional(),
  notes: z.string().max(50000).nullable().optional(),
  revision: z.number().int().positive(),
});

export type CreateTask = z.infer<typeof createTaskSchema>;
export type UpdateTask = z.infer<typeof updateTaskSchema>;
export type CreateProject = z.infer<typeof createProjectSchema>;
export type UpdateProject = z.infer<typeof updateProjectSchema>;
export type CreateDeal = z.infer<typeof createDealSchema>;
export type UpdateDeal = z.infer<typeof updateDealSchema>;
export type CreateContact = z.infer<typeof createContactSchema>;
export type UpdateContact = z.infer<typeof updateContactSchema>;
export type CreateFinance = z.infer<typeof createFinanceSchema>;
export type UpdateFinance = z.infer<typeof updateFinanceSchema>;
