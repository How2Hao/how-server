import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { map, Observable } from 'rxjs';

interface Data<T> {
  data: T;
}

@Injectable()
export class Response<T> implements NestInterceptor {
  intercept(
    _context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<Data<T>> {
    return next.handle().pipe(
      map((data) => {
        return {
          data,
          code: 0,
          message: 'success',
        };
      }),
    );
  }
}
