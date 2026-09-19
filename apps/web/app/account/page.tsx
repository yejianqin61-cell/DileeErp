import { AccountCenter } from "../../components/account/account-center";
import { PageHeader } from "../../components/layout/app-shell";

/**
 * 账号管理中心。**所有角色都能进**（用户拍板）：
 * 自助部分改姓名/改密码/看权限范围；账号管理区块只对老板、财务渲染。
 */
export default function AccountPage() {
  return <div className="page-root" data-testid="page-account">
    <PageHeader title="账号管理中心" description="改自己的姓名与密码、查看自己的权限范围；老板与财务还可以管理其它账号" />
    <AccountCenter />
  </div>;
}
