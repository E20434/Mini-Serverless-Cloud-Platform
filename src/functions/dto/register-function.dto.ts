import { IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

/**
 * `filePath` is GONE as of Phase 5 - registering a function now only
 * declares its name and resource defaults. Code arrives separately via
 * `POST /functions/:name/versions` (a real upload, stored in object
 * storage, built into a real image) - closing the scope limit flagged
 * back in Phase 3, for real, instead of just noting it.
 */
export class RegisterFunctionDto {
  @IsString()
  @Matches(/^[a-zA-Z0-9_-]+$/, {
    message: 'name may only contain letters, numbers, hyphens, and underscores',
  })
  name!: string;

  @IsOptional()
  @IsInt()
  @Min(64)
  @Max(3008)
  memoryMb?: number;

  @IsOptional()
  @IsInt()
  @Min(100)
  @Max(60000)
  timeoutMs?: number;
}
