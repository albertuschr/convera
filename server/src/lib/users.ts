export interface UserRow { id: string; name: string; email: string; phone: string; password_changed_at: Date }
export const publicUser = (r: UserRow) => ({
  id: r.id, name: r.name, email: r.email, phone: r.phone, passwordUpdatedAt: r.password_changed_at.toISOString(),
});
