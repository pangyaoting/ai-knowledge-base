/**
 * 站点法定标识（**唯一改动点**：备案号/域名变了只改这里）
 *
 * - ICP 备案号：《非经营性互联网信息服务备案管理办法》第 13 条 —— 必须"在其网站主页底部的
 *   中央位置标明其备案编号，并将备案编号链接到信息产业部备案管理系统网址"。
 *   完整格式：`<省简称>ICP备<8 位编号>号-<网站序号>`（网站序号从 -1 起，同一主体备案多个网站依次递增）。
 * - 公安联网备案号：ICP 备案通过后 **30 日内**到"全国互联网安全管理服务平台"登记（公安部 33 号令
 *   第 11/12 条），办完拿到编号填进 POLICE_BEIAN —— 同样要求在页脚展示；没办就保持 null（不渲染）。
 */
export const ICP_BEIAN = {
  /** 广东省通信管理局核发 */
  number: '粤ICP备2026135674号-1',
  url: 'https://beian.miit.gov.cn',
} as const;

/** 公安联网备案（beian.mps.gov.cn 办理）；办完填 { number: '粤公网安备 440xxxxxxxxxxxxx号', url: '...' } */
export const POLICE_BEIAN: { number: string; url: string } | null = null;

/** 正式域名（备案通过的域名，页脚展示用；www 需与主域名一起备案才能解析） */
export const SITE_DOMAIN = 'aiknowbase.cn';

/**
 * 隐私政策/用户协议里的联系方式（个人信息权利行使、投诉、注销申请都走这里）。
 * ⚠️ 换成你**真实可收件**的邮箱再上线 —— 法条要求提供有效联系方式，写一个不收信的地址等于没提供。
 * （备案时管局也会核验邮箱，建议就用备案填的那个。）
 */
export const CONTACT_EMAIL = 'contact@aiknowbase.cn';
