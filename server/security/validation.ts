import { z } from 'zod';

export const SensitiveStringSchema = z.string().superRefine((val, ctx) => {
  // Add checks if needed, but primarily used for typing / tagging
  if (val.trim().length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Sensitive string cannot be empty',
    });
  }
});

/**
 * Zod everywhere: Validate input deeply against schema and strip unknown properties.
 */
export function validateInput<T>(schema: z.ZodType<T>, data: unknown, contextName: string = 'Data'): T {
  try {
    return schema.parse(data);
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      const messages = err.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; ');
      throw new Error(`${contextName} validation failed: ${messages}`);
    }
    throw err;
  }
}

/**
 * Zod schema for Tool Execution Proposals (P27)
 */
export const ToolProposalSchema = z.object({
  toolId: z.string().min(1),
  input: z.unknown(), // tool-specific validation happens in the pipeline/registry
  cycleId: z.string().min(1).optional(),
});

/**
 * Zod schema for Identity creation
 */
export const CreateIdentitySchema = z.object({
  kind: z.enum(['owner', 'person', 'guest']),
  displayName: z.string().min(1),
  preferredName: z.string().optional(),
  relationshipToOwner: z.string().optional(),
  passphrase: SensitiveStringSchema.optional(),
  recoveryCode: SensitiveStringSchema.optional(),
});

/**
 * Zod schema for generic domain events
 */
export const DomainEventPayloadSchema = z.object({
  type: z.string().min(1),
  payload: z.record(z.unknown()),
  identityId: z.string().min(1).optional(),
  cycleId: z.string().min(1).optional(),
  timestamp: z.number().optional(),
});
