import { Injectable } from '@nestjs/common';
import { CredentialsDto } from './dto/login.zod.dto';

@Injectable()
export class UserService {
  create(createUserDto: CredentialsDto) {
    return createUserDto;
  }

  findAll() {
    return `This action returns all user`;
  }

  findOne(id: number) {
    return `This action returns a #${id} user`;
  }

  update(id: number) {
    return `This action updates a #${id} user`;
  }

  remove(id: number) {
    return `This action removes a #${id} user`;
  }
}
