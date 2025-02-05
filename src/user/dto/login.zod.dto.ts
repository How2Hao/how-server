import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const CredentialsSchema = z.object({
  username: z.string(),
  password: z
    .string()
    .min(6, { message: 'Password must be at least 6 characters long.' }),
});

// class is required for using DTO as a type
export class CredentialsDto extends createZodDto(CredentialsSchema) {}
