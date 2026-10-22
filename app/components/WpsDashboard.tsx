"use client";

import { useCallback, useRef, useState } from "react";
import { Check, ChevronDown, Cloud, FileText, Grid2X2, LockKeyhole, MessageSquare } from "lucide-react";
import ConnectionPanel from "./ConnectionPanel.tsx";
import WpsWorkspace from "./WpsWorkspace.tsx";
import AcceptancePanel from "./AcceptancePanel.tsx";
import PresentationComposer from "./PresentationComposer.tsx";
import type { ConnectionStatus } from "./wps-client.ts";

export default function WpsDashboard({ displayName, email }: { displayName: string; email: string }) {
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const invalidating = useRef(false);
  const connectionStamp = useRef<number | undefined>(undefined);
  const receiveStatus = useCallback((next: ConnectionStatus) => {
    if (connectionStamp.current !== undefined && next.connectedAt !== connectionStamp.current) setRefreshNonce((value) => value + 1);
    connectionStamp.current = next.connectedAt;
    if (next.connected) invalidating.current = false;
    setStatus(next);
  }, []);
  const credentialInvalidated = useCallback(() => {
    if (invalidating.current) return;
    invalidating.current = true;
    setStatus((current) => current ? { ...current, connected: false, upstreamVerified: false, status: "expired" } : current);
    setRefreshNonce((value) => value + 1);
  }, []);
  return <div className="site-shell">
    <header className="site-header"><a className="brand" href="#connection" aria-label="WPS 云文档连接首页"><span className="brand-mark"><Cloud size={23} strokeWidth={1.8} /></span><span><strong>云文档连接</strong><small>WPS · PERSONAL</small></span></a><nav className="main-nav" aria-label="主要导航"><a href="#connection">我的连接</a><a href="#presentation">制作 PPT</a><a href="#acceptance">任务验收</a><a href="#catalog">工具目录</a><a href="#workbench">JSON 工作台</a><a href="#help">帮助</a></nav><div className="header-right"><span className="privacy-pill"><LockKeyhole size={12} />私有工作区</span><span className="user-avatar" title={`当前登录：${displayName}（${email}）`} aria-label={`当前用户 ${displayName}`}>{displayName.trim().slice(0, 1).toUpperCase() || "我"}</span></div></header>
    <main>
      <section className="hero" id="connection" aria-labelledby="hero-heading"><div className="hero-copy"><p className="eyebrow"><span />个人金山文档 · 云端连接</p><h1 id="hero-heading">让文档，<br /><em>在对话中继续。</em></h1><p className="hero-description">连接你的个人 WPS 云文档。<br />在聊天中提出需求，<br />也能在这里查看工具、审阅计划、运行操作。</p><div className="hero-benefits"><span><Check size={15} />无需电脑常开</span><span><Check size={15} />无需本地端口</span><span><Check size={15} />每次操作可审阅</span></div><div className="connection-illustration" aria-hidden="true"><div className="illustration-app"><MessageSquare size={22} strokeWidth={1.6} /><span>一句话</span></div><span className="illustration-line"><span /><span /><span /></span><div className="illustration-cloud"><Cloud size={28} strokeWidth={1.5} /></div><span className="illustration-line"><span /><span /><span /></span><div className="illustration-docs"><span className="mini-sheet"><Grid2X2 size={20} /></span><span className="mini-doc"><FileText size={21} /><i /><i /></span></div><span className="illustration-caption">从一个想法，到一份云端成果。</span></div><div className="hero-quick-links"><a href="#presentation">制作一份 PPT <span>↗</span></a><a href="#acceptance">运行任务验收 <span>↗</span></a></div></div><ConnectionPanel key={refreshNonce} onStatus={receiveStatus} /></section>
      <section className="how-it-works" aria-label="使用步骤"><div className="step"><span className="step-number">01</span><div><strong>连接并验证</strong><p>授权个人账号，做一次只读检查</p></div></div><ChevronDown className="step-arrow" size={18} /><div className="step"><span className="step-number">02</span><div><strong>选择工具或模板</strong><p>查找文档、整理表格、准备问卷</p></div></div><ChevronDown className="step-arrow" size={18} /><div className="step"><span className="step-number">03</span><div><strong>审阅后执行</strong><p>确认参数，运行后核对结果</p></div></div></section>
      <PresentationComposer connected={!!status?.connected} connectionVersion={refreshNonce} onCredentialInvalidated={credentialInvalidated} />
      <AcceptancePanel connected={!!status?.connected} refreshNonce={refreshNonce} onCredentialInvalidated={credentialInvalidated} />
      <WpsWorkspace connected={!!status?.connected} onCredentialInvalidated={credentialInvalidated} />
      <section className="help-section" id="help" aria-labelledby="help-heading"><div className="help-intro"><p className="section-kicker">A LITTLE CLARITY</p><h2 id="help-heading">把连接弄明白，<br />把操作掌握好。</h2><p>云端文件与本地软件有不同能力。<br />每项操作的范围，都可以先查看。</p></div><div className="help-list">
        <details><summary>这是直接控制我电脑上的 WPS 吗？<ChevronDown size={17} /></summary><p>这里连接个人金山文档的云端服务，不需要运行桌面 WPS 或开放电脑端口。本地文件需要先上传到云端。桌面排版、宏等功能是否支持，取决于官方工具接口。</p></details>
        <details><summary>为什么官方授权完成后，页面还在等待？<ChevronDown size={17} /></summary><p>WPS 官方授权与本服务接收凭据是两个步骤。此页会在本次等待窗口内持续检查，短暂网络错误会自动退避重试，刷新后会恢复未结束的请求。请使用同一次授权页面；取消或过期后需要重新发起。诊断卡会显示错误码与请求编号，复制诊断不会包含凭据。</p></details>
        <details><summary>任务验收“通过”意味着什么？<ChevronDown size={17} /></summary><p>验收会在你的账号中新建专用测试文件，并逐项检查实际内容与基础结构。通过只适用于这次报告中已完成的检查；视觉排版、未运行的步骤和其他文件不在已验证范围内。HTTP 请求成功或工具目录收录不代表任务验收通过。</p></details>
        <details><summary>工具目录里的所有功能都一定可用吗？<ChevronDown size={17} /></summary><p>目录展示从官方服务获取的工具名称与参数。具体能力仍受文件格式、账号权限和官方接口限制；没有逐项完成真实账号验证。涉及发布、删除、分享或权限变化的工具会标为敏感操作，执行前仍需通过参数与权限检查。</p></details>
        <details><summary>怎样在 ChatGPT 对话中使用？<ChevronDown size={17} /></summary><p>在 ChatGPT 的「Plugins → Personal → Created by you」中安装并连接本服务的配套插件，然后在对话中选择它。可以先说：“请通过 WPS 云文档连接查找标题包含会议的文件，暂时不要修改。”此页面的账号授权状态与聊天中的插件启用状态是两个步骤。</p></details>
        <details><summary>JSON 预检会修改文档吗？<ChevronDown size={17} /></summary><p>预检只检查工具、参数和引用，展示计划中的读取与写入步骤，不执行文档操作。点击运行后才会调用 WPS。模板也只填入编辑器。多步骤执行不是事务：前面已完成的写入不会因为后续失败而撤销；不确定状态应先只读核对。</p></details>
        <details><summary>问卷草稿会直接公开吗？<ChevronDown size={17} /></summary><p>工作台问卷模板只创建草稿，不包含发布操作。公开发布需要单独选择对应工具、检查参数并确认敏感操作。创建后的真实草稿 ID 应以执行结果为准。</p></details>
        <details><summary>凭据与执行结果如何保存？<ChevronDown size={17} /></summary><p>授权凭据在云端加密保存，按当前登录用户隔离，不回显到页面或聊天。手动备用连接只接受此页密码框输入，提交后清空，不存入浏览器本地。普通执行结果保留在当前页面，可自行下载备查；任务验收会保存检查摘要和测试文件编号，不保存文档正文。断开连接会删除本服务保存的授权，不会删除 WPS 文件。</p></details>
      </div></section>
    </main>
    <footer className="site-footer"><span><Cloud size={15} />让你的想法，接上云端文档。</span><span>个人连接服务 · 非 WPS 官方产品</span></footer>
  </div>;
}
