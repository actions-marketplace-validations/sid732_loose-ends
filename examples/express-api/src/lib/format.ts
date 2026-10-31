export interface User {
  id: number;
  first: string;
  last: string;
}

export function formatUser(user: User) {
  return { id: user.id, name: `${user.first} ${user.last}` };
}
