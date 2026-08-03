/**
 * Генерує ADMIN_PASSWORD_HASH для змінних оточення.
 *
 *   npm run admin:hash -- "ваш-пароль"
 *
 * Хеш можна спокійно тримати у Vercel: відновити з нього пароль неможливо.
 */
import { hashPassword } from '../src/auth.js';

const password = process.argv[2];

if (!password) {
  console.error('\n❌ Вкажіть пароль:\n   npm run admin:hash -- "ваш-пароль"\n');
  process.exitCode = 1;
} else if (password.length < 8) {
  console.error('\n❌ Пароль закороткий — щонайменше 8 символів.\n');
  process.exitCode = 1;
} else {
  console.log('\nДодайте це у змінні оточення (Vercel → Settings → Environment Variables):\n');
  console.log(`ADMIN_PASSWORD_HASH=${hashPassword(password)}\n`);
  console.log('Сам пароль нікуди не записуйте — він потрібен лише щоб увійти в /admin.\n');
}
