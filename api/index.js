/**
 * Точка входу для Vercel.
 *
 * Vercel сам знаходить файли в теці /api і робить з них serverless-функції.
 * Тут ми лише віддаємо готовий Express-застосунок: Express сумісний із
 * сигнатурою (req, res), тож окрема обгортка не потрібна.
 *
 * app.listen() тут НЕ викликається навмисно — порт слухає платформа.
 */
import { buildApp } from '../server/src/app.js';

export default buildApp();
