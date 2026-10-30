import { z } from 'zod';

export const email = z.string().trim().toLowerCase().email('Format email tidak valid').max(254);
export const password = z
  .string()
  .min(8, 'Password minimal 8 karakter')
  .max(128, 'Password maksimal 128 karakter')
  .refine((p) => /[A-Za-z]/.test(p) && /\d/.test(p), 'Gunakan kombinasi huruf dan angka');
export const name = z.string().trim().min(1, 'Nama wajib diisi').max(120);

const normPhone = (p: string) => { let d = p.replace(/\D/g, ''); if (d.startsWith('0')) d = '62' + d.slice(1); else if (d.startsWith('8')) d = '62' + d; return d; };
export const phone = z.string().trim().max(32).refine((p) => p === '' || /^62\d{8,13}$/.test(normPhone(p)), 'Nomor telepon tidak valid');

export const uuid = z.string().uuid();
export const datasetId = z.string().trim().regex(/^\d{15,16}$/, 'Dataset ID harus 15–16 digit angka');
export const accessToken = z.string().trim().min(20, 'Access token terlalu pendek').max(1024).regex(/^\S+$/, 'Access token tidak boleh mengandung spasi');
export const role = z.enum(['owner', 'cs', 'agency']);
export type Role = z.infer<typeof role>;
