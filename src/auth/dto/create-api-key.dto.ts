import { ArrayMinSize, ArrayUnique, IsArray, IsIn, IsString } from 'class-validator';
import { API_SCOPES, ApiScope } from '../scopes';

export class CreateApiKeyDto {
  @IsString()
  name!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsIn(API_SCOPES, { each: true })
  scopes!: ApiScope[];
}
