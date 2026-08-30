import request from './request';

/** 修改个人资料（昵称/头像） */
export function updateProfile(data: { nickname?: string; avatar?: string }) {
  return request.patch<unknown, { id: string; email: string; nickname: string | null }>(
    '/user/profile',
    data,
  );
}

/** 上传头像（base64 data URL，png/jpeg/webp） */
export function uploadAvatar(avatar: string) {
  return request.post<unknown, { id: string; avatar: string | null }>('/user/avatar', { avatar });
}

/** 修改密码 */
export function changePassword(data: { oldPassword: string; newPassword: string }) {
  return request.post<unknown, { success: boolean }>('/user/change-password', data);
}
