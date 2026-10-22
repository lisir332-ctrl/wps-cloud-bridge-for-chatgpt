import { ArrowRight, Cloud, LockKeyhole, Sparkles } from "lucide-react";
import { chatGPTSignInPath, getChatGPTUser } from "./chatgpt-auth";
import ConnectionPanel from "./components/ConnectionPanel";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await getChatGPTUser();
  return <div className="simple-connect-page">
    <header className="simple-connect-header"><div className="simple-connect-brand"><Cloud size={22} /><strong>WPS Cloud Bridge</strong></div><span><LockKeyhole size={13} />个人连接</span></header>
    <main className="simple-connect-main">
      <div className="connect-visual" aria-hidden="true"><span className="connect-aura" /><span className="connect-node connect-node-chat"><Sparkles size={26} /></span><span className="connect-signal"><i /><i /><i /></span><span className="connect-node connect-node-wps">W</span></div>
      <p className="simple-connect-kicker">独立开源连接器</p>
      <h1>WPS 云文档<br /><span>在 ChatGPT 中使用</span></h1>
      <p className="simple-connect-subtitle">文档，直接聊。</p>
      {user ? <ConnectionPanel compact /> : <div className="simple-signin-card"><a className="button button-primary" href={chatGPTSignInPath("/")} target="_top">连接 ChatGPT <ArrowRight size={17} /></a></div>}
      <p className="simple-connect-hint">连接后，回到对话说出你的任务。</p>
    </main>
  </div>;
}
