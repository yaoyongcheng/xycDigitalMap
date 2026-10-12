(function () {
  const titles = { home: "首页", work: "工作台", msg: "消息", mine: "我的" };

  const icon = (d) =>
    `<svg viewBox="0 0 24 24"><path d="${d}"/></svg>`;

  const msgIco = {
    people: `<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8.2" r="2.8"/><path d="M5.8 19.2c.8-3.2 3.1-4.8 6.2-4.8s5.4 1.6 6.2 4.8"/></svg>`,
    inspect: `<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="6.2" cy="6.2" r="2"/><circle cx="17.8" cy="6.2" r="2"/><circle cx="6.2" cy="17.8" r="2"/><circle cx="17.8" cy="17.8" r="2"/><path d="M8.2 6.2h7.6M8.2 17.8h7.6M6.2 8.2v7.6M17.8 8.2v7.6"/><rect x="10" y="10" width="4" height="4" rx="0.8"/></svg>`
  };

  const messages = [
    { kind: "people", title: "人员预警", desc: "这是一条人员预警消息", time: "15:51:45", unread: 1 },
    { kind: "inspect", title: "巡检预警", desc: "无人机巡检识别到道路垃圾、电缆拖地等现场风险", time: "1分钟前", unread: 1 }
  ];

  const menuSvg = {
    sites: "M5 20V7.5L12 4l7 3.5V20 M9.5 20v-5h5v5",
    setting: "M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4z M4.5 12h2 M17.5 12h2 M6.2 6.2l1.5 1.5 M16.3 16.3l1.5 1.5 M6.2 17.8l1.5-1.5 M16.3 7.7l1.5-1.5",
    about: "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z M12 11v5 M12 8v.5"
  };

  const mineMenus = [
    { id: "sites", name: "我的工地" },
    { id: "setting", name: "设置" },
    { id: "about", name: "关于" }
  ];

  const camPosCycle = ["pos-left", "pos-right", "pos-bottom", ""];
  const cameras = [
    { id: "g1", name: "1#门监控", group: "出入口" },
    { id: "g1a", name: "1#门安全通道门禁监控", group: "出入口" },
    { id: "g2a", name: "2#门监控1", group: "出入口" },
    { id: "g2b", name: "2#门监控2", group: "出入口" },
    { id: "g3out", name: "3#门外监控", group: "出入口" },
    { id: "g4", name: "4#门监控", group: "出入口" },
    { id: "g4a", name: "4#门安全通道门禁监控", group: "出入口" },
    { id: "g5", name: "5#门监控", group: "出入口" },
    { id: "g5out", name: "5#门外监控", group: "出入口" },
    { id: "cama", name: "监控A", group: "场内" },
    { id: "camb", name: "监控B", group: "场内" },
    { id: "weigh", name: "地磅全景", group: "场内" },
    { id: "rebar", name: "钢筋加工棚", group: "场内" },
    { id: "yard1", name: "场内1", group: "场内" },
    { id: "yard2", name: "场内2", group: "场内" },
    { id: "talk", name: "安全讲台", group: "场内" },
    { id: "crane2", name: "2#塔吊", group: "塔吊" },
    { id: "crane4", name: "4#塔吊", group: "塔吊" }
  ].map((c) => Object.assign(c, { img: "img/cam-crane2.jpg", pos: "" }));
  const camShotPool = ["img/cam-crane2.jpg", "img/cam-crane2.jpg", "img/cam-crane2.jpg"];
  const camShotTimes = ["08:12", "12:36", "16:50"];


  const navTitle = document.getElementById("navTitle");
  const subpage = document.getElementById("subpage");
  const subTitle = document.getElementById("subTitle");
  const subBody = document.getElementById("subBody");
  const appEl = document.getElementById("app");

  let homeMod = "safety";

  function switchTab(tab) {
    document.querySelectorAll(".page").forEach((p) => p.classList.toggle("active", p.id === "page-" + tab));
    document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    navTitle.textContent = titles[tab];
    appEl.classList.toggle("home-mode", tab === "home");
    closeSub(true);
    closeCam();
    closeAir();
    if (tab === "home" && homeMod === "safety") requestAnimationFrame(startAlarmFeed);
    else stopAlarmFeed();
  }

  function camStamp() {
    const d = new Date();
    const days = "日一二三四五六";
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} 星期${days[d.getDay()]} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} 4G`;
  }

  const camIco = `<span class="cam-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 8.2h10.2v9.2H4.5z"/><path d="M14.7 11.2 19.5 8.8v8.2l-4.8-2.4z"/></svg></span>`;
  const starSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 4.6 14.2 9l5 .7-3.6 3.5.9 5L12 16.1 7.5 18.2l.9-5L4.8 9.7 9.8 9z"/></svg>`;

  function camById(id) {
    return cameras.find((c) => c.id === id) || cameras[0];
  }

  function renderCamCard(cam) {
    const stamp = camStamp();
    return `
      <div class="cam-card" data-cam="${cam.id}">
        <div class="cam-card-hd">
          ${camIco}
          <strong>${cam.name}</strong>
          <button class="cam-star" type="button" aria-label="收藏">${starSvg}</button>
        </div>
        <div class="cam-card-pic ${cam.pos}">
          <img src="${cam.img}" alt="${cam.name} 最新一帧" />
          <span class="cam-time">${stamp}</span>
          <span class="cam-play" aria-hidden="true"></span>
        </div>
      </div>`;
  }

  function renderScene(title, camId) {
    return `
      <div class="safe-block scene-block">
        <h4>${title}</h4>
        ${renderCamCard(camById(camId))}
      </div>`;
  }

  function lineThrough(pts, tension) {
    if (!pts.length) return "";
    const t = tension == null ? 0.7 : tension;
    let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
    if (pts.length === 1) return d;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2] || p2;
      const c1x = p1[0] + (p2[0] - p0[0]) / 6 * t;
      const c1y = p1[1] + (p2[1] - p0[1]) / 6 * t;
      const c2x = p2[0] - (p3[0] - p1[0]) / 6 * t;
      const c2y = p2[1] - (p3[1] - p1[1]) / 6 * t;
      d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
    }
    return d;
  }

  function alarmTrendSvg(fillId) {
    const hist = { "10/2": 2, "10/3": 3, "10/4": 6, "10/5": 16, "10/6": 13, "10/7": 8, "10/8": 4 };
    const end = startOfDay(new Date());
    const days = [];
    const vals = [];
    for (let i = 6; i >= 0; i--) {
      const d = addDays(end, -i);
      const lab = (d.getMonth() + 1) + "/" + d.getDate();
      days.push(lab);
      vals.push(i === 0 ? latestAlarms.length : (hist[lab] != null ? hist[lab] : 3));
    }
    const w = 260;
    const h = 78;
    const pl = 24;
    const pr = 16;
    const pt = 10;
    const pb = 20;
    const maxY = 20;
    const n = days.length;
    const xAt = (i) => pl + (i / (n - 1)) * (w - pl - pr);
    const yAt = (v) => pt + (1 - v / maxY) * (h - pt - pb);
    const pts = vals.map((v, i) => [xAt(i), yAt(v)]);
    const line = lineThrough(pts, 0.7);
    const base = yAt(0).toFixed(1);
    const area = `${line} L${xAt(n - 1).toFixed(1)},${base} L${xAt(0).toFixed(1)},${base} Z`;
    const grids = [0, 10, 20].map((t) => {
      const y = yAt(t).toFixed(1);
      return `<line x1="${pl}" x2="${w - pr}" y1="${y}" y2="${y}"/><text x="${pl - 4}" y="${(+y + 3).toFixed(1)}" text-anchor="end">${t}</text>`;
    }).join("");
    const labels = days.map((d, i) =>
      `<text x="${xAt(i).toFixed(1)}" y="${h - 1}" text-anchor="middle">${d}</text>`
    ).join("");
    const dots = pts.map(([x, y]) =>
      `<circle class="alarm-dot" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.3"/>`
    ).join("");
    const gid = fillId || "alarmFill";
    return `<svg class="alarm-svg" viewBox="0 0 ${w} ${h}">
      <defs>
        <linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#4C9FFF" stop-opacity="0.32"/>
          <stop offset="100%" stop-color="#4C9FFF" stop-opacity="0.03"/>
        </linearGradient>
      </defs>
      <g class="alarm-grid">${grids}</g>
      <path d="${area}" fill="url(#${gid})"/>
      <path d="${line}" fill="none" stroke="#4C9FFF" stroke-width="1.6" stroke-linejoin="round"/>
      ${dots}
      <g class="alarm-x">${labels}</g>
    </svg>`;
  }

  function smoothPath(pts) {
    let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const cpx = ((pts[i][0] + pts[i + 1][0]) / 2).toFixed(1);
      d += ` C${cpx},${pts[i][1].toFixed(1)} ${cpx},${pts[i + 1][1].toFixed(1)} ${pts[i + 1][0].toFixed(1)},${pts[i + 1][1].toFixed(1)}`;
    }
    return d;
  }

  function peopleHourSvg() {
    const hourNums = [1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23];
    const hours = hourNums.map((h) => h + ":00");
    const workersAll = [2, 2, 2, 8, 36, 33, 18, 24, 27, 12, 4, 2];
    const managersAll = [2, 2, 2, 2, 7, 19, 3, 5, 10, 6, 2, 2];
    const nowH = new Date().getHours();
    const liveN = hourNums.reduce((n, h, i) => (h <= nowH ? i + 1 : n), 0);
    const workers = workersAll.slice(0, liveN);
    const managers = managersAll.slice(0, liveN);
    const w = 320;
    const h = 148;
    const pl = 28;
    const pr = 16;
    const pt = 10;
    const pb = 22;
    const maxY = 40;
    const ticksN = hours.length;
    const xAt = (i) => pl + (i / (ticksN - 1)) * (w - pl - pr);
    const yAt = (v) => pt + (1 - v / maxY) * (h - pt - pb);
    const wPts = workers.map((v, i) => [xAt(i), yAt(v)]);
    const mPts = managers.map((v, i) => [xAt(i), yAt(v)]);
    const wLine = wPts.length ? smoothPath(wPts) : "";
    const mLine = mPts.length ? smoothPath(mPts) : "";
    const last = Math.max(workers.length - 1, 0);
    const base = yAt(0).toFixed(1);
    const area = wPts.length
      ? `${wLine} L${xAt(last).toFixed(1)},${base} L${xAt(0).toFixed(1)},${base} Z`
      : "";
    const grids = [0, 10, 20, 30, 40].map((t) => {
      const y = yAt(t).toFixed(1);
      return `<line x1="${pl}" x2="${w - pr}" y1="${y}" y2="${y}"/><text x="${pl - 4}" y="${(+y + 3).toFixed(1)}" text-anchor="end">${t}</text>`;
    }).join("");
    const labels = hours.map((d, i) => {
      const show = i === 0 || i === ticksN - 1 || i % 2 === 0;
      if (!show) return "";
      const anchor = i === 0 ? "start" : i === ticksN - 1 ? "end" : "middle";
      const dim = i >= liveN ? ` opacity="0.35"` : "";
      return `<text x="${xAt(i).toFixed(1)}" y="${h - 4}" text-anchor="${anchor}"${dim}>${hourNums[i]}:00</text>`;
    }).join("");
    return `<svg class="people-hour-svg" viewBox="0 0 ${w} ${h}">
      <defs>
        <linearGradient id="peopleFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#3DDC97" stop-opacity="0.45"/>
          <stop offset="100%" stop-color="#3DDC97" stop-opacity="0.04"/>
        </linearGradient>
      </defs>
      <g class="alarm-grid">${grids}</g>
      <path d="${area}" fill="url(#peopleFill)"/>
      <path d="${wLine}" fill="none" stroke="#3DDC97" stroke-width="2"/>
      <path d="${mLine}" fill="none" stroke="#4C9FFF" stroke-width="2"/>
      <g class="alarm-x">${labels}</g>
    </svg>`;
  }

  const inspectAlarms = [
    { id: "trash", day: "today", type: "道路垃圾", title: "环境报警", desc: "场区道路发现垃圾堆放未清理！", img: "img/alarm-trash.jpg", rel: "1分钟前", at: "2026-10-08 15:21:00", geo: "114.24751233100210,30.53310211883421" },
    { id: "cable", day: "today", type: "电缆拖地", title: "用电报警", desc: "作业面电缆拖地未架空，存在触电隐患！", img: "img/alarm-cable.jpg", rel: "3分钟前", at: "2026-10-08 15:19:00", geo: "114.24738810244102,30.53290155210933" },
    { id: "net", day: "today", type: "安全网缺失", title: "防护报警", desc: "楼层临边安全网缺失，请立即整改！", img: "img/alarm-net.jpg", rel: "12分钟前", at: "2026-10-08 15:10:00", geo: "114.24742027911455,30.53296304904549" },
    { id: "soil", day: "today", type: "裸土未覆盖", title: "扬尘报警", desc: "场区裸土未覆盖，扬尘风险较高！", img: "img/alarm-soil.jpg", rel: "1小时前", at: "2026-10-08 14:22:00", geo: "114.24760188412003,30.53322190771208" },
    { id: "h-net", day: "hist", type: "安全网缺失", title: "防护报警", desc: "3#楼作业面临边安全网破损缺失。", img: "img/alarm-net.jpg", rel: "昨天 09:30", at: "2026-09-30 09:30:00", geo: "114.24742027911455,30.53296304904549" },
    { id: "h-trash", day: "hist", type: "道路垃圾", title: "环境报警", desc: "场区北侧道路垃圾堆放未及时清运。", img: "img/alarm-trash.jpg", rel: "10/7 16:20", at: "2026-10-07 16:20:00", geo: "114.24749822001145,30.53308044122890" },
    { id: "h-cable", day: "hist", type: "电缆拖地", title: "用电报警", desc: "钢筋加工区电缆拖地，存在漏电风险。", img: "img/alarm-cable.jpg", rel: "10/6 11:08", at: "2026-10-06 11:08:00", geo: "114.24735501988210,30.53284411902341" },
    { id: "h-soil", day: "hist", type: "裸土未覆盖", title: "扬尘报警", desc: "基坑周边裸土未覆盖，扬尘超标。", img: "img/alarm-soil.jpg", rel: "10/5 08:46", at: "2026-10-05 08:46:00", geo: "114.24757700124480,30.53319822009112" }
  ];

  const latestAlarms = inspectAlarms.filter((a) => a.day === "today");

  const ALARM_FEED_SHOW = 3;
  let alarmFeedTimer = 0;
  let alarmFeedIdx = 0;

  function alarmFeedItem(a) {
    return `
      <div class="alarm-feed-item" data-alarm="${a.id}" role="button">
        <img class="alarm-feed-pic" src="${a.img}" alt="${a.type}" />
        <div class="alarm-feed-meta">
          <strong>${a.title}</strong>
          <p>${a.desc}</p>
        </div>
        <span class="alarm-feed-time">${a.rel}</span>
      </div>`;
  }

  function renderAlarmFeed() {
    const list = latestAlarms.slice();
    const extra = list.length > ALARM_FEED_SHOW ? list.slice(0, ALARM_FEED_SHOW) : [];
    return `
      <div class="home-chart-card alarm-feed">
        <div class="alarm-feed-win">
          <div class="alarm-feed-track" id="alarmFeedTrack">
            ${list.concat(extra).map(alarmFeedItem).join("")}
          </div>
        </div>
      </div>`;
  }

  function stopAlarmFeed() {
    clearInterval(alarmFeedTimer);
    alarmFeedTimer = 0;
    alarmFeedIdx = 0;
  }

  function startAlarmFeed() {
    stopAlarmFeed();
    const track = document.getElementById("alarmFeedTrack");
    const win = track && track.parentElement;
    if (!track || !win || latestAlarms.length <= ALARM_FEED_SHOW) return;
    const item = track.querySelector(".alarm-feed-item");
    if (!item) return;
    const h = item.offsetHeight;
    win.style.height = h * ALARM_FEED_SHOW + "px";
    track.style.transform = "translateY(0)";
    alarmFeedTimer = setInterval(() => {
      alarmFeedIdx += 1;
      track.style.transition = "transform 0.45s ease";
      track.style.transform = `translateY(${-alarmFeedIdx * h}px)`;
      if (alarmFeedIdx >= latestAlarms.length) {
        setTimeout(() => {
          track.style.transition = "none";
          track.style.transform = "translateY(0)";
          alarmFeedIdx = 0;
        }, 460);
      }
    }, 4000);
  }

  const b2Occupied = { 1: 5, 4: 1 };
  const b2FloorCount = 5;
  const peopleTree = [
    { id: "yard", name: "场布", count: 38 },
    {
      id: "b2",
      name: "2#楼",
      count: 6,
      children: Array.from({ length: b2FloorCount }, (_, i) => {
        const n = i + 1;
        return { id: "b2-" + n, name: n + "F", count: b2Occupied[n] || 0 };
      })
    },
    { id: "base", name: "地下室", count: 2 }
  ];

  let peopleNode = null;

  function peopleChildren() {
    return peopleNode && peopleNode.children ? peopleNode.children : peopleTree;
  }

  function renderPeopleDist() {
    const box = document.getElementById("peopleDist");
    if (!box) return;
    if (peopleNode && peopleNode.children) {
      const floors = peopleNode.children;
      const live = floors.filter((n) => n.count).length;
      box.innerHTML = `
        <button class="people-back" type="button" data-people="back">
          <em>‹</em>
          <strong>${peopleNode.name}</strong>
          <b>${peopleNode.count}<i>人</i></b>
        </button>
        <div class="people-sub">有人 ${live}层 · 共${floors.length}层</div>
        <div class="people-floor-grid">${floors.map((n) => `
          <div class="people-floor${n.count ? "" : " empty"}">
            <span>${n.name}</span>
            <b>${n.count}</b>
          </div>`).join("")}</div>`;
      return;
    }
    box.innerHTML = `<div class="people-zones">${peopleTree.map((n) => `
      <button class="people-zone${n.children ? " drill" : ""}" type="button" data-people="${n.id}">
        <span>${n.name}</span>
        <b>${n.count}<em>人</em></b>
        ${n.children ? "<i>›</i>" : ""}
      </button>`).join("")}</div>`;
  }

  function renderSafety() {
    return `
      <div class="safe-block">
        <h4>预警</h4>
        <div class="home-stats alarm-row">
          <div class="home-stat alert"><b>${latestAlarms.length}</b><span>今日预警数</span></div>
          <div class="home-chart-card alarm-mini">
            <span class="home-card-lab">近7日预警趋势</span>
            ${alarmTrendSvg()}
          </div>
        </div>
        ${renderAlarmFeed()}
      </div>
      <div class="safe-block">
        <h4>人员</h4>
        <div class="safe-stack">
          <div class="home-chart-card crew-card">
            <span class="home-card-lab">作业人数</span>
            <div class="crew-overview">${[
              ["160", "人", "项目人数"],
              ["40", "人", "正在上班"],
              ["76", "人", "今日出勤"],
              ["47.5", "%", "出勤率"]
            ].map(([n, unit, name]) => `
              <div class="crew-kpi"><b>${n}<em>${unit}</em></b><span>${name}</span></div>
            `).join("")}</div>
          </div>
          <div class="home-chart-card people-dist">
            <span class="home-card-lab">人员区域分布</span>
            <div id="peopleDist"></div>
          </div>
          <div class="home-chart-card people-hour">
            <div class="people-hour-hd">
              <span class="home-card-lab">今日时段趋势</span>
              <div class="people-hour-leg">
                <span><i class="g"></i>工人</span>
                <span><i class="b"></i>管理人员</span>
              </div>
            </div>
            <div class="people-hour-y">人数</div>
            ${peopleHourSvg()}
          </div>
        </div>
      </div>`;
  }

  const siteBuildings = [
    { name: "酒店", done: 16, total: 16, plan: "正常", rate: 96 },
    { name: "1#楼", done: 1, total: 8, plan: "正常", rate: 92 },
    { name: "2#楼", done: 1, total: 33, plan: "正常", rate: 88 },
    { name: "3#楼", done: 1, total: 33, plan: "正常", rate: 71 },
    { name: "4#楼", done: 1, total: 8, plan: "正常", rate: 90 },
    { name: "幼儿园", done: 3, total: 3, plan: "正常", rate: 94 }
  ];
  const qaCats = [
    { name: "土建主体", last: 93, now: 93 },
    { name: "二次结构", last: 89, now: 89 },
    { name: "门窗栏杆", last: 91, now: 91 },
    { name: "机电", last: 89, now: 89 },
    { name: "外立面", last: 89, now: 89 }
  ];
  const qaSteps = [
    { name: "验收工序1", n: 1, color: "#4C9FFF" },
    { name: "验收工序2", n: 1, color: "#22C55E" },
    { name: "验收工序3", n: 3, color: "#F5C14A" },
    { name: "验收工序4", n: 1, color: "#FF6B6B" }
  ];

  function landQaState(rate) {
    if (rate >= 90) return "on";
    if (rate >= 80) return "warn";
    return "off";
  }

  function renderQuality() {
    const stepTotal = qaSteps.reduce((s, d) => s + d.n, 0);
    let acc = 0;
    const pie = "conic-gradient(" + qaSteps.map((d) => {
      const a = acc;
      acc += (d.n / stepTotal) * 100;
      return `${d.color} ${a}% ${acc}%`;
    }).join(", ") + ")";
    return `
      <div class="safe-block">
        <h4>合格率</h4>
        <div class="home-chart-card qa-pass">
          <div class="qa-pass-hd">
            <span>合格率%</span>
            <div class="qa-pass-leg">
              <span><i class="last"></i>上月合格率</span>
              <span><i class="now"></i>本月合格率</span>
            </div>
          </div>
          <div class="qa-pass-plot">
            <div class="qa-pass-y"><em>100</em><em>80</em><em>60</em><em>40</em><em>20</em><em>0</em></div>
            <div class="qa-pass-cols">${qaCats.map((d) => `
              <div class="qa-pass-col">
                <div class="qa-pass-pair">
                  <b class="last" style="height:${d.last}%"><em>${d.last}</em></b>
                  <b class="now" style="height:${d.now}%"><em>${d.now}</em></b>
                </div>
                <span>${d.name}</span>
              </div>`).join("")}</div>
          </div>
        </div>
      </div>
      <div class="safe-block">
        <h4>验收工序</h4>
        <div class="home-chart-card">
          <div class="home-chart-row qa-chart">
            <div class="donut qa-step-donut" style="background:${pie}">
              <div class="donut-label"><b>100</b><span>验收工序</span></div>
            </div>
            <div class="qa-legend">${qaSteps.map((d) => `
              <div class="qa-legend-item"><i style="background:${d.color}"></i><span>${d.name}</span><em>${d.n}</em></div>
            `).join("")}</div>
          </div>
        </div>
      </div>`;
  }

  const msFlag = `<svg viewBox="0 0 24 24"><path d="M7 21V4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M8 4.4h10.2l-2.6 3.6 2.6 3.6H8z" fill="currentColor"/></svg>`;

  function renderProgress() {
    const milestones = [
      { name: "项目开始", plan: "2025-08-15", actual: "2026-07-15", delta: -31, state: "done" },
      { name: "施工图审查完成", plan: "2025-10-15", actual: "2025-09-30", delta: -15, state: "done" },
      { name: "新建地下室出正负零", plan: "2026-11-01", actual: "--", state: "now" },
      { name: "既有结构加固改造完成", plan: "2026-12-30", actual: "--", state: "todo" },
      { name: "主体结构封顶", plan: "2027-03-16", actual: "--", state: "todo" },
      { name: "外立面、机电安装完成", plan: "2027-09-30", actual: "--", state: "todo" },
      { name: "项目竣工", plan: "2027-10-23", actual: "--", state: "todo" }
    ];
    const buildings = siteBuildings;
    return `
      <div class="safe-block">
        <h4>项目总里程碑</h4>
        <div class="home-chart-card ms-card">
          <div class="ms-list">${milestones.map((m) => `
            <div class="ms-item ${m.state}">
              <i class="ms-ico">${msFlag}</i>
              <div class="ms-body">
                <strong>${m.name}</strong>
                <p>计划完成 <b>${m.plan}</b></p>
                <p>实际完成 <b>${m.actual}</b>${m.delta != null ? `<em class="ok">(${m.delta})</em>` : ""}</p>
              </div>
            </div>`).join("")}</div>
        </div>
      </div>
      <div class="safe-block">
        <h4>楼栋进度</h4>
        <div class="pg-list">${buildings.map((b) => {
      const pct = Math.round((b.done / b.total) * 100);
      const late = b.plan === "滞后";
      return `
        <div class="pg-card${late ? " late" : ""}">
          <div class="pg-hd">
            <strong>${b.name}</strong>
            <span class="pg-bar"><i style="width:${pct}%"></i></span>
            <b>${b.done}/${b.total}F</b>
          </div>
        </div>`;
    }).join("")}</div>
      </div>`;
  }

  const siteEquip = [
    { id: "crane", name: "5G塔机", value: "15.69t", metric: "今日吊重", ico: "crane",
      units: [{ name: "5G塔机", on: true, rows: [["今日吊重", "15.69t"]] }] },
    { id: "lift", name: "智能电梯", value: "122次", metric: "今日升降次数", ico: "lift",
      units: [
        { name: "智能电梯1-1", on: true, rows: [["今日循环次数", "122次"], ["今日运行时长", "10.2h"]] },
        { name: "智能电梯1-2", on: false, rows: [["今日循环次数", "0次"], ["今日运行时长", "0.0h"]] },
        { name: "智能电梯2-1", on: false, rows: [["今日循环次数", "0次"], ["今日运行时长", "0.0h"]] },
        { name: "智能电梯2-2", on: true, rows: [["今日循环次数", "0次"], ["今日运行时长", "0.0h"]] }
      ] },
    { id: "drone", name: "无人机", value: "12次", metric: "今日作业次数", ico: "drone",
      units: [{ name: "无人机", on: true, rows: [["今日作业次数", "12次"]] }] },
    { id: "climb", name: "智能爬架", value: "21m", metric: "爬升高度", ico: "climb",
      units: [{ name: "智能爬架", on: true, rows: [["爬升高度", "21m"]] }] },
    { id: "grind", name: "地砖研磨机器人", value: "5次", metric: "今日作业次数", ico: "robot",
      units: [{ name: "地砖研磨机器人", on: true, rows: [["今日作业次数", "5次"]] }] },
    { id: "plaster", name: "抹灰机器人", value: "4次", metric: "今日作业次数", ico: "robot",
      units: [{ name: "抹灰机器人", on: true, rows: [["今日作业次数", "4次"]] }] },
    { id: "measure", name: "测量机器人", value: "7次", metric: "今日作业次数", ico: "robot",
      units: [{ name: "测量机器人", on: true, rows: [["今日作业次数", "7次"]] }] },
    { id: "spray", name: "喷涂机器人", value: "9次", metric: "今日作业次数", ico: "robot",
      units: [{ name: "喷涂机器人", on: true, rows: [["今日作业次数", "9次"]] }] },
    { id: "level", name: "混凝土整平机器人", value: "3次", metric: "今日作业次数", ico: "robot",
      units: [{ name: "混凝土整平机器人", on: true, rows: [["今日作业次数", "3次"]] }] }
  ];

  let eqNode = null;

  function equipCount(d) {
    const on = d.units.filter((u) => u.on).length;
    const total = d.units.length;
    return { on, total, st: on <= 0 ? "off" : on < total ? "warn" : "on" };
  }

  function renderEquip() {
    if (eqNode) {
      return `
        <button class="eq-back" type="button" data-eq="back">
          <em>‹</em>
          <strong>${eqNode.name}</strong>
          <b>${equipCount(eqNode).on}/${eqNode.units.length}</b>
        </button>
        <div class="eq-units">${eqNode.units.map((u) => `
          <div class="eq-unit">
            <div class="eq-hd">
              <strong>${u.name}</strong>
              <i class="eq-dot ${u.on ? "on" : "off"}"></i>
            </div>
            ${u.rows.map((r) => `<div class="eq-kv"><span>${r[0]}</span><b>${r[1]}</b></div>`).join("")}
          </div>`).join("")}</div>`;
    }
    const kinds = siteEquip.length;
    const qty = siteEquip.reduce((s, d) => s + d.units.length, 0);
    const on = siteEquip.reduce((s, d) => s + d.units.filter((u) => u.on).length, 0);
    const off = qty - on;
    const onPct = qty ? (on / qty) * 100 : 0;
    const pie = `conic-gradient(#2EE6A6 0% ${onPct}%, #3A4E66 ${onPct}% 100%)`;
    return `
      <div class="home-stats alarm-row">
        <div class="home-chart-card eq-count">
          <div class="eq-count-item"><b>${kinds}<em>种</em></b><span>设备种类</span></div>
          <div class="eq-count-item"><b>${qty}<em>台</em></b><span>设备数量</span></div>
        </div>
        <div class="home-chart-card eq-status">
          <span class="alarm-mini-lab">设备状态</span>
          <div class="eq-status-body">
            <i class="donut eq-status-donut" style="background:${pie}"></i>
            <div class="eq-status-leg">
              <div><i class="on"></i><span>在线</span><b>${on}</b></div>
              <div><i class="off"></i><span>离线</span><b>${off}</b></div>
            </div>
          </div>
        </div>
      </div>
      <div class="eq-grid">${siteEquip.map((d) => {
        const c = equipCount(d);
        const drill = c.total > 1;
        return `
        <button class="eq-card${drill ? " drill" : ""}" type="button"${drill ? ` data-eq="${d.id}" aria-label="${d.name}，点击展开明细"` : ""}>
          <div class="eq-hd">
            <strong>${d.name}</strong>
            <i class="eq-dot ${c.st}"></i>
            ${drill ? `<em>${c.on}/${c.total}</em>` : ""}
          </div>
          <div class="eq-val">
            <b>${d.value}</b>
            <span>${d.metric}</span>
          </div>
          ${drill ? `<span class="eq-more" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M10 6l6 6-6 6"/></svg></span>` : ""}
        </button>`;
      }).join("")}</div>`;
  }

  function renderHomePanel(mod) {
    stopAlarmFeed();
    if (mod !== "equip") eqNode = null;
    const box = document.getElementById("homePanels");
    if (mod === "safety") box.innerHTML = renderSafety();
    else if (mod === "quality") box.innerHTML = renderQuality();
    else if (mod === "progress") box.innerHTML = renderProgress();
    else if (mod === "equip") box.innerHTML = renderEquip();
    if (mod === "safety") {
      renderPeopleDist();
      requestAnimationFrame(startAlarmFeed);
    }
  }

  function renderMsgs() {
    document.getElementById("msgList").innerHTML = messages.map((m) => `
      <div class="msg-item${m.kind === "inspect" ? " is-link" : ""}" data-kind="${m.kind}">
        <div class="msg-ico ${m.kind}">${msgIco[m.kind]}</div>
        <div class="meta">
          <h4>${m.title}</h4>
          <p>${m.desc}</p>
        </div>
        <div class="msg-side">
          <span class="msg-time">${m.time}</span>
          ${m.unread ? `<b class="msg-badge">${m.unread}</b>` : ""}
        </div>
      </div>`).join("");
  }

  function renderMine() {
    document.getElementById("mineMenu").innerHTML = mineMenus.map((m) => `
      <button class="menu-item" data-mine="${m.id}" data-name="${m.name}">
        <span class="menu-ico">${icon(menuSvg[m.id])}</span>
        <strong>${m.name}</strong>
        <span class="arrow">›</span>
      </button>`).join("");
  }

  function inspectListItem(a) {
    return `
      <div class="insp-item" data-alarm="${a.id}" role="button">
        <img class="insp-pic" src="${a.img}" alt="${a.type}" />
        <div class="insp-meta">
          <strong>${a.type}</strong>
          <p>${a.desc}</p>
        </div>
        <span class="insp-time">${a.rel}</span>
      </div>`;
  }

  let inspTab = "today";
  function protoToday() {
    return startOfDay(new Date(2026, 9, 8));
  }
  let inspHistDate = addDays(protoToday(), -1);
  let inspCalMonth = startOfDay(new Date(inspHistDate.getFullYear(), inspHistDate.getMonth(), 1));

  function dateKey(d) {
    const x = startOfDay(d);
    return x.getFullYear() + "-" + String(x.getMonth() + 1).padStart(2, "0") + "-" + String(x.getDate()).padStart(2, "0");
  }

  function alarmsOnDate(d) {
    const key = dateKey(d);
    return inspectAlarms.filter((a) => a.day === "hist" && a.at.slice(0, 10) === key);
  }

  function inspCalMaxDay() {
    return addDays(protoToday(), -1);
  }

  function inspCalEls() {
    return {
      cal: document.getElementById("inspCal"),
      title: document.getElementById("inspCalTitle"),
      grid: document.getElementById("inspCalGrid"),
      prev: document.getElementById("inspCalPrev"),
      next: document.getElementById("inspCalNext")
    };
  }

  function paintInspCal() {
    const els = inspCalEls();
    if (!els.cal) return;
    fillMonthCal(inspCalMonth, inspHistDate, els.title, els.grid, els.prev, els.next, {
      maxDay: inspCalMaxDay()
    });
  }

  function hideInspCal() {
    const cal = document.getElementById("inspCal");
    if (cal) cal.classList.add("hide");
  }

  function showInspCal() {
    inspCalMonth = startOfDay(new Date(inspHistDate.getFullYear(), inspHistDate.getMonth(), 1));
    paintInspCal();
    const cal = document.getElementById("inspCal");
    if (cal) cal.classList.remove("hide");
    const hist = subBody.querySelector(".insp-hist");
    if (hist) hist.scrollIntoView({ block: "start" });
  }

  function renderInspectList() {
    const today = inspectAlarms.filter((a) => a.day === "today");
    const hist = alarmsOnDate(inspHistDate);
    const histLab = formatCamDate(inspHistDate);
    const onHist = inspTab === "hist";
    return `
      <div class="insp-page">
        <div class="insp-tabs">
          <button class="insp-tab${onHist ? "" : " on"}" type="button" data-insp-tab="today">今日预警</button>
          <button class="insp-tab${onHist ? " on" : ""}" type="button" data-insp-tab="hist">历史预警</button>
        </div>
        <div class="insp-pane${onHist ? " hide" : ""}">
          <div class="home-stats alarm-row">
            <div class="home-stat alert"><b>${today.length}</b><span>今日预警数</span></div>
            <div class="home-chart-card alarm-mini">
              <span class="alarm-mini-lab">近7日预警趋势</span>
              ${alarmTrendSvg("inspAlarmFill")}
            </div>
          </div>
          <div class="insp-list">${today.map(inspectListItem).join("")}</div>
        </div>
        <div class="insp-pane insp-hist${onHist ? "" : " hide"}">
          <div class="insp-hist-hd">
            <div>
              <strong>${sameDay(inspHistDate, inspCalMaxDay()) ? "昨天" : histLab}</strong>
              <span>${hist.length}条</span>
            </div>
            <button class="cam-day cam-day-pick on" type="button" data-insp-cal-open="1">
              ${sameDay(inspHistDate, inspCalMaxDay()) ? "昨天" : formatMD(inspHistDate)}
              ${calIco}
            </button>
          </div>
          <div class="cam-cal hide" id="inspCal">
            <div class="cam-cal-hd">
              <button class="cam-cal-nav" id="inspCalPrev" type="button" aria-label="上一月">‹</button>
              <strong id="inspCalTitle">2026年10月</strong>
              <button class="cam-cal-nav" id="inspCalNext" type="button" aria-label="下一月">›</button>
            </div>
            <div class="cam-cal-week">
              <span>日</span><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span>
            </div>
            <div class="cam-cal-grid" id="inspCalGrid"></div>
          </div>
          ${hist.length
            ? `<div class="insp-list">${hist.map(inspectListItem).join("")}</div>`
            : `<div class="insp-empty">该日暂无巡检预警</div>`}
        </div>
      </div>`;
  }

  function renderAlarmDetail(a) {
    return `
      <div class="alarm-hero">
        <img src="${a.img}" alt="${a.type}" />
        <div class="alarm-hero-tag">
          <strong>自动巡航无人机</strong>
          <span>UAV-25638583</span>
        </div>
      </div>
      <div class="alarm-info">
        <h4>基础信息</h4>
        <div class="alarm-kv"><span>项目名称</span><em>中建三局-向阳村项目</em></div>
        <div class="alarm-kv"><span>任务名称</span><em>向阳村-三维(加密)</em></div>
        <div class="alarm-kv"><span>检测时间</span><em>${a.at}</em></div>
        <h4>识别结果</h4>
        <div class="alarm-kv"><span>识别类型</span><em>${a.type}</em><b>自动</b><i>0级</i></div>
        <div class="alarm-kv"><span>地址</span><em>湖北省武汉市汉阳区江堤街道江永堤路铉龙城</em></div>
        <div class="alarm-kv"><span>经纬度</span><em class="alarm-geo">${a.geo}</em></div>
      </div>`;
  }

  let subBack = null;

  function paintSub(title, html) {
    subTitle.textContent = title;
    subBody.innerHTML = html;
    subpage.classList.add("open");
  }

  function openInspectList(tab) {
    if (tab === "today" || tab === "hist") inspTab = tab;
    subBack = null;
    subpage.classList.remove("is-alarm");
    paintSub("巡检预警", renderInspectList());
  }

  function openAlarmDetail(id, fromList) {
    const a = inspectAlarms.find((x) => x.id === id);
    if (!a) return;
    subBack = fromList ? openInspectList : null;
    subpage.classList.add("is-alarm");
    paintSub("预警详情", renderAlarmDetail(a));
  }

  function openSub(title, html) {
    subBack = null;
    subpage.classList.remove("is-alarm");
    paintSub(title, html);
  }

  function closeSub(force) {
    const inspCal = document.getElementById("inspCal");
    if (force !== true && inspCal && !inspCal.classList.contains("hide")) {
      hideInspCal();
      return;
    }
    if (force !== true && subBack) {
      const fn = subBack;
      subBack = null;
      fn();
      return;
    }
    subBack = null;
    subpage.classList.remove("open", "is-alarm");
  }

  function pageHtml(name) {
    return `
      <div class="card">
        <p class="empty-note">「${name}」内页。这里只保留「我的」相关功能入口，后续按账号、工地和设置补齐。</p>
      </div>`;
  }

  document.getElementById("tabbar").addEventListener("click", (e) => {
    const btn = e.target.closest(".tab");
    if (btn) switchTab(btn.dataset.tab);
  });

  document.getElementById("mineMenu").addEventListener("click", (e) => {
    const item = e.target.closest("[data-mine]");
    if (item) openSub(item.dataset.name, pageHtml(item.dataset.name));
  });

  function showToast(text) {
    const el = document.getElementById("toast");
    el.textContent = text;
    el.classList.add("show");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => el.classList.remove("show"), 1600);
  }

  document.getElementById("btnLogout").addEventListener("click", () => {
    showToast("已退出登录");
  });

  document.getElementById("btnBack").addEventListener("click", closeSub);

  document.getElementById("msgList").addEventListener("click", (e) => {
    const item = e.target.closest(".msg-item");
    if (!item || item.dataset.kind !== "inspect") return;
    openInspectList("today");
  });

  subBody.addEventListener("click", (e) => {
    const prev = e.target.closest("#inspCalPrev");
    if (prev) {
      if (prev.disabled) return;
      inspCalMonth.setMonth(inspCalMonth.getMonth() - 1);
      paintInspCal();
      return;
    }
    const next = e.target.closest("#inspCalNext");
    if (next) {
      if (next.disabled) return;
      inspCalMonth.setMonth(inspCalMonth.getMonth() + 1);
      paintInspCal();
      return;
    }
    const calDay = e.target.closest("#inspCalGrid [data-cal]");
    if (calDay) {
      if (calDay.disabled) return;
      const [y, m, d] = calDay.dataset.cal.split("-").map(Number);
      inspHistDate = startOfDay(new Date(y, m - 1, d));
      openInspectList("hist");
      return;
    }
    const tab = e.target.closest("[data-insp-tab]");
    if (tab) {
      hideInspCal();
      openInspectList(tab.dataset.inspTab);
      return;
    }
    const pick = e.target.closest("[data-insp-cal-open]");
    if (pick) {
      const cal = document.getElementById("inspCal");
      if (!cal) return;
      if (cal.classList.contains("hide")) showInspCal();
      else hideInspCal();
      return;
    }
    const item = e.target.closest("[data-alarm]");
    if (item) openAlarmDetail(item.dataset.alarm, true);
  });

  const pageHome = document.getElementById("page-home");
  let sheetUp = true;

  function setSheetUp(up) {
    sheetUp = !!up;
    if (sheetUp) {
      const pageRect = pageHome.getBoundingClientRect();
      const prog = pageHome.querySelector(".home-progress");
      const progRect = prog.getBoundingClientRect();
      const top = Math.round(progRect.bottom - pageRect.top + 12);
      pageHome.style.setProperty("--sheet-up-top", top + "px");
      pageHome.classList.add("is-sheet-up");
    } else {
      pageHome.classList.remove("is-sheet-up");
    }
  }

  document.getElementById("homeMods").addEventListener("click", (e) => {
    const btn = e.target.closest(".home-mod");
    if (!btn) return;
    homeMod = btn.dataset.mod;
    document.querySelectorAll(".home-mod").forEach((b) => b.classList.toggle("on", b === btn));
    renderHomePanel(homeMod);
  });

  document.getElementById("btnSheetToggle").addEventListener("click", () => setSheetUp(!sheetUp));
  window.addEventListener("resize", () => { if (sheetUp) setSheetUp(true); });
  requestAnimationFrame(() => setSheetUp(true));

  document.getElementById("homePanels").addEventListener("click", (e) => {
    const eqBtn = e.target.closest("[data-eq]");
    if (eqBtn) {
      if (eqBtn.dataset.eq === "back") eqNode = null;
      else eqNode = siteEquip.find((d) => d.id === eqBtn.dataset.eq) || null;
      document.getElementById("homePanels").innerHTML = renderEquip();
      return;
    }
    const peopleBtn = e.target.closest("[data-people]");
    if (peopleBtn) {
      const id = peopleBtn.dataset.people;
      if (id === "back") {
        peopleNode = null;
        renderPeopleDist();
        return;
      }
      const node = peopleChildren().find((n) => n.id === id);
      if (node && node.children) {
        peopleNode = node;
        renderPeopleDist();
      }
      return;
    }
    const alarm = e.target.closest("[data-alarm]");
    if (alarm) {
      openInspectList("today");
      return;
    }
    const cfg = e.target.closest(".cam-cfg");
    if (cfg) {
      e.stopPropagation();
      showToast("视频监控配置");
      return;
    }
    const star = e.target.closest(".cam-star");
    if (star) {
      e.stopPropagation();
      star.classList.toggle("on");
      return;
    }
    const card = e.target.closest(".cam-card");
    if (card) openCam(card.dataset.cam);
  });

  document.getElementById("workShorts").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-work]");
    if (!btn) return;
    const kind = btn.dataset.work;
    if (kind === "cam") openCam(cameras[0].id);
    else if (kind === "photo") openAir();
    else if (kind === "hazard") openHazard();
    else showToast("功能待定");
  });

  const phone = document.querySelector(".phone");
  const mapLand = document.getElementById("mapLand");
  const camPlayer = document.getElementById("camPlayer");
  const camLiveView = document.getElementById("camLiveView");
  const camShotsView = document.getElementById("camShotsView");
  const camChips = document.getElementById("camPlayerChips");
  const camFrame = document.getElementById("camPlayerFrame");
  const camName = document.getElementById("camPlayerName");
  const camTime = document.getElementById("camPlayerTime");
  const camShotDays = document.getElementById("camShotDays");
  const camShotGrid = document.getElementById("camShotGrid");
  const camShotPop = document.getElementById("camShotPop");
  const camShotImg = document.getElementById("camShotImg");
  const camShotMeta = document.getElementById("camShotMeta");
  const camCal = document.getElementById("camCal");
  const camCalTitle = document.getElementById("camCalTitle");
  const camCalGrid = document.getElementById("camCalGrid");
  const camCalPrev = document.getElementById("camCalPrev");
  const camCalNext = document.getElementById("camCalNext");
  let camId = cameras[0].id;
  let camMode = "live";
  let camShotDate = startOfDay(new Date());
  let camCalMonth = startOfDay(new Date());
  let camShots = [];

  function startOfDay(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  }

  function sameDay(a, b) {
    return startOfDay(a).getTime() === startOfDay(b).getTime();
  }

  function addDays(d, n) {
    const x = startOfDay(d);
    x.setDate(x.getDate() + n);
    return x;
  }

  function dayOffsetOf(d) {
    return Math.round((startOfDay(new Date()) - startOfDay(d)) / 86400000);
  }

  function formatMD(d) {
    const x = startOfDay(d);
    return String(x.getMonth() + 1).padStart(2, "0") + "/" + String(x.getDate()).padStart(2, "0");
  }

  function camDayLabel(offset) {
    return formatCamDate(addDays(new Date(), -offset));
  }

  function formatCamDate(d) {
    const off = dayOffsetOf(d);
    if (off === 0) return "今天";
    if (off === 1) return "昨天";
    return formatMD(d);
  }

  function shotsFor(id, day) {
    const i = cameras.findIndex((c) => c.id === id);
    return camShotTimes.map((t, n) => ({
      time: t,
      img: camShotPool[(i + Math.abs(day) + n) % camShotPool.length],
      pos: ["pos-left", "pos-right", "pos-bottom"][n]
    }));
  }

  const calIco = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M8 3v4M16 3v4"/></svg>`;

  function calMinMonth() {
    const d = startOfDay(new Date());
    d.setMonth(d.getMonth() - 11);
    d.setDate(1);
    return d;
  }

  function calMaxMonth() {
    const d = startOfDay(new Date());
    d.setDate(1);
    return d;
  }

  function dayPickChips(selected, openAttr) {
    const today = startOfDay(new Date());
    const yest = addDays(today, -1);
    const picked = dayOffsetOf(selected) > 1;
    return `
      <button class="cam-day${sameDay(selected, today) ? " on" : ""}" type="button" data-day="0">今天</button>
      <button class="cam-day${sameDay(selected, yest) ? " on" : ""}" type="button" data-day="1">昨天</button>
      <button class="cam-day cam-day-pick${picked ? " on" : ""}" type="button" ${openAttr}>
        ${picked ? formatMD(selected) : "选日期"}
        ${calIco}
      </button>`;
  }

  function fillMonthCal(month, selected, titleEl, gridEl, prevBtn, nextBtn, opts) {
    const y = month.getFullYear();
    const m = month.getMonth();
    const maxDay = startOfDay((opts && opts.maxDay) || new Date());
    const maxMonth = startOfDay(new Date(maxDay.getFullYear(), maxDay.getMonth(), 1));
    titleEl.textContent = y + "年" + (m + 1) + "月";
    prevBtn.disabled = month <= calMinMonth();
    nextBtn.disabled = month >= maxMonth;
    const firstDow = new Date(y, m, 1).getDay();
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const today = startOfDay(new Date());
    const cells = [];
    for (let i = 0; i < firstDow; i++) cells.push('<span class="cam-cal-day off"></span>');
    for (let d = 1; d <= daysInMonth; d++) {
      const date = new Date(y, m, d);
      const blocked = startOfDay(date) > maxDay;
      const on = sameDay(date, selected);
      const isToday = sameDay(date, today);
      cells.push(
        `<button class="cam-cal-day${on ? " on" : ""}${isToday ? " today" : ""}" type="button" data-cal="${y}-${m + 1}-${d}" ${blocked ? "disabled" : ""}>${d}</button>`
      );
    }
    gridEl.innerHTML = cells.join("");
  }

  function hideCamCal() {
    camCal.classList.add("hide");
  }

  function renderCamCal() {
    fillMonthCal(camCalMonth, camShotDate, camCalTitle, camCalGrid, camCalPrev, camCalNext);
  }

  function showCamCal() {
    camCalMonth = startOfDay(new Date(camShotDate.getFullYear(), camShotDate.getMonth(), 1));
    renderCamCal();
    camCal.classList.remove("hide");
  }

  function showCamMode(mode) {
    camMode = mode;
    camLiveView.classList.toggle("hide", mode !== "live");
    camShotsView.classList.toggle("hide", mode !== "shots");
  }

  function renderCamChips() {
    const groups = [];
    cameras.forEach((c) => {
      let g = groups.find((x) => x.name === c.group);
      if (!g) {
        g = { name: c.group, items: [] };
        groups.push(g);
      }
      g.items.push(c);
    });
    camChips.innerHTML = groups.map((g) => `
      <div class="cam-chip-group">
        <h5>${g.name}<em>${g.items.length}</em></h5>
        <div class="cam-chip-grid">
          ${g.items.map((c) =>
            `<button class="cam-chip${c.id === camId ? " on" : ""}" type="button" data-cam="${c.id}">${c.name}</button>`
          ).join("")}
        </div>
      </div>`).join("");
  }

  function renderCamShots() {
    camShotDays.innerHTML = dayPickChips(camShotDate, 'data-cal-open="1"');
    camShots = shotsFor(camId, dayOffsetOf(camShotDate));
    const label = formatCamDate(camShotDate);
    camShotGrid.innerHTML = camShots.map((s, i) => `
      <button class="cam-shot" type="button" data-shot="${i}">
        <img class="${s.pos}" src="${s.img}" alt="${s.time} 抓拍" />
        <span>${label} ${s.time}</span>
      </button>`).join("");
  }

  function applyCam(id, keepLive) {
    const cam = cameras.find((c) => c.id === id) || cameras[0];
    camId = cam.id;
    camFrame.src = cam.img;
    camFrame.className = cam.pos;
    camName.textContent = cam.name;
    camTime.textContent = camStamp();
    camShotDate = startOfDay(new Date());
    hideCamCal();
    renderCamChips();
    renderCamShots();
    if (!keepLive) camPlayer.classList.remove("live");
  }

  function setCamLand(on) {
    phone.classList.toggle("is-landscape", on);
    camPlayer.classList.toggle("is-land", on);
    const txt = document.getElementById("camLandText");
    if (txt) txt.textContent = on ? "退出全屏" : "全屏";
  }

  function openCam(id) {
    closeAir();
    closeHazard();
    setCamLand(false);
    camPlayer.hidden = false;
    camPlayer.classList.add("open");
    camPlayer.setAttribute("aria-hidden", "false");
    applyCam(id, false);
    showCamMode("live");
  }

  function closeCam() {
    setCamLand(false);
    camPlayer.classList.remove("open", "live");
    camPlayer.setAttribute("aria-hidden", "true");
    camPlayer.hidden = true;
    camShotPop.classList.remove("open");
    camShotPop.hidden = true;
    hideCamCal();
    showCamMode("live");
  }

  document.getElementById("btnCamPlay").addEventListener("click", () => {
    camPlayer.classList.add("live");
    camTime.textContent = camStamp();
  });

  document.getElementById("btnCamBack").addEventListener("click", () => {
    if (camShotPop.classList.contains("open")) {
      camShotPop.classList.remove("open");
      return;
    }
    if (!camCal.classList.contains("hide")) {
      hideCamCal();
      return;
    }
    if (camMode === "shots") {
      hideCamCal();
      showCamMode("live");
      return;
    }
    if (camPlayer.classList.contains("is-land")) {
      setCamLand(false);
      return;
    }
    closeCam();
  });

  document.getElementById("btnCamShots").addEventListener("click", () => {
    camShotDate = startOfDay(new Date());
    hideCamCal();
    renderCamShots();
    showCamMode("shots");
  });

  document.getElementById("btnCamLand").addEventListener("click", () => {
    setCamLand(!camPlayer.classList.contains("is-land"));
  });

  camChips.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-cam]");
    if (chip) applyCam(chip.dataset.cam, camPlayer.classList.contains("live"));
  });

  camShotDays.addEventListener("click", (e) => {
    const pick = e.target.closest("[data-cal-open]");
    if (pick) {
      if (camCal.classList.contains("hide")) showCamCal();
      else hideCamCal();
      return;
    }
    const btn = e.target.closest("[data-day]");
    if (!btn) return;
    hideCamCal();
    camShotDate = addDays(new Date(), -Number(btn.dataset.day));
    renderCamShots();
  });

  camCalPrev.addEventListener("click", () => {
    if (camCalPrev.disabled) return;
    camCalMonth.setMonth(camCalMonth.getMonth() - 1);
    renderCamCal();
  });

  camCalNext.addEventListener("click", () => {
    if (camCalNext.disabled) return;
    camCalMonth.setMonth(camCalMonth.getMonth() + 1);
    renderCamCal();
  });

  camCalGrid.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-cal]");
    if (!btn || btn.disabled) return;
    const [y, m, d] = btn.dataset.cal.split("-").map(Number);
    camShotDate = startOfDay(new Date(y, m - 1, d));
    hideCamCal();
    renderCamShots();
  });

  camShotGrid.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-shot]");
    if (!btn) return;
    const shot = camShots[Number(btn.dataset.shot)];
    if (!shot) return;
    camShotImg.src = shot.img;
    camShotImg.className = shot.pos;
    camShotMeta.textContent = camName.textContent + "  " + formatCamDate(camShotDate) + "  " + shot.time;
    camShotPop.hidden = false;
    camShotPop.classList.add("open");
  });

  document.getElementById("btnShotClose").addEventListener("click", () => {
    camShotPop.classList.remove("open");
    camShotPop.hidden = true;
  });

  const airPlayer = document.getElementById("airPlayer");
  const airDays = document.getElementById("airDays");
  const airHint = document.getElementById("airHint");
  const airGrid = document.getElementById("airGrid");
  const airPop = document.getElementById("airPop");
  const airPopImg = document.getElementById("airPopImg");
  const airPopMeta = document.getElementById("airPopMeta");
  const airCal = document.getElementById("airCal");
  const airCalTitle = document.getElementById("airCalTitle");
  const airCalGrid = document.getElementById("airCalGrid");
  const airCalPrev = document.getElementById("airCalPrev");
  const airCalNext = document.getElementById("airCalNext");
  const airImgs = ["img/aerial-a.jpg", "img/aerial-b.jpg"];
  const airTimes = ["07:22", "08:15", "09:08", "10:32", "11:46", "13:18", "14:55", "16:12", "17:38", "18:21"];
  const airPos = ["pos-tl", "pos-tr", "pos-c", "pos-bl", "pos-br", "pos-l", "pos-r", "pos-t", "pos-b", "pos-c"];
  let airDate = startOfDay(new Date());
  let airCalMonth = startOfDay(new Date());
  let airList = [];

  function airShots(day) {
    const n = 8 + (Math.abs(day) % 3);
    return airTimes.slice(0, n).map((t, i) => ({
      time: t,
      img: airImgs[(i + Math.abs(day)) % airImgs.length],
      pos: airPos[i % airPos.length]
    }));
  }

  function hideAirCal() {
    airCal.classList.add("hide");
  }

  function renderAirCal() {
    fillMonthCal(airCalMonth, airDate, airCalTitle, airCalGrid, airCalPrev, airCalNext);
  }

  function showAirCal() {
    airCalMonth = startOfDay(new Date(airDate.getFullYear(), airDate.getMonth(), 1));
    renderAirCal();
    airCal.classList.remove("hide");
  }

  function renderAir() {
    airDays.innerHTML = dayPickChips(airDate, 'data-air-cal-open="1"');
    const offset = dayOffsetOf(airDate);
    airList = airShots(offset);
    const label = formatCamDate(airDate);
    airHint.textContent = label + "  无人机定点拍摄  " + airList.length + " 张";
    airGrid.innerHTML = airList.map((s, i) => `
      <button class="air-card" type="button" data-air="${i}">
        <img class="${s.pos}" src="${s.img}" alt="${label} ${s.time} 航拍" />
        <span>${label} ${s.time}</span>
      </button>`).join("");
  }

  function openAir() {
    closeCam();
    closeHazard();
    airDate = startOfDay(new Date());
    hideAirCal();
    airPop.classList.remove("open");
    renderAir();
    airPlayer.hidden = false;
    airPlayer.classList.add("open");
    airPlayer.setAttribute("aria-hidden", "false");
  }

  function closeAir() {
    if (!airPlayer) return;
    hideAirCal();
    airPlayer.classList.remove("open");
    airPlayer.setAttribute("aria-hidden", "true");
    airPlayer.hidden = true;
    airPop.classList.remove("open");
    airPop.hidden = true;
  }

  const hazardPage = document.getElementById("hazardPage");
  const hazardPhotos = document.getElementById("hazardPhotos");
  const hazardFile = document.getElementById("hazardFile");
  const hazardTypes = document.getElementById("hazardTypes");
  const hazardDesc = document.getElementById("hazardDesc");
  const hazardKindList = ["安全防护", "文明施工", "用电隐患", "消防通道", "其他"];
  let hazardKind = hazardKindList[0];
  let hazardImgs = [];

  function renderHazardTypes() {
    hazardTypes.innerHTML = hazardKindList.map((k) =>
      `<button class="hazard-type${k === hazardKind ? " on" : ""}" type="button" data-hazard-type="${k}">${k}</button>`
    ).join("");
  }

  function renderHazardPhotos() {
    const add = hazardImgs.length < 6
      ? `<button class="hazard-add" id="btnHazardAdd" type="button">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 7v10M7 12h10"/><rect x="4" y="5" width="16" height="14" rx="2"/></svg>
          拍照/相册
        </button>`
      : "";
    hazardPhotos.innerHTML = hazardImgs.map((src, i) => `
      <div class="hazard-thumb">
        <img src="${src}" alt="隐患照片 ${i + 1}" />
        <button class="hazard-del" type="button" data-hazard-del="${i}" aria-label="删除">×</button>
      </div>`).join("") + add;
  }

  function resetHazard() {
    hazardImgs.forEach((src) => URL.revokeObjectURL(src));
    hazardImgs = [];
    hazardKind = hazardKindList[0];
    hazardDesc.value = "";
    if (hazardFile) hazardFile.value = "";
    renderHazardTypes();
    renderHazardPhotos();
  }

  function openHazard() {
    closeCam();
    closeAir();
    resetHazard();
    hazardPage.hidden = false;
    hazardPage.classList.add("open");
    hazardPage.setAttribute("aria-hidden", "false");
  }

  function closeHazard() {
    if (!hazardPage) return;
    hazardPage.classList.remove("open");
    hazardPage.setAttribute("aria-hidden", "true");
    hazardPage.hidden = true;
    resetHazard();
  }

  document.getElementById("btnHazardBack").addEventListener("click", closeHazard);

  hazardPhotos.addEventListener("click", (e) => {
    const add = e.target.closest("#btnHazardAdd");
    if (add) {
      hazardFile.click();
      return;
    }
    const del = e.target.closest("[data-hazard-del]");
    if (!del) return;
    const i = Number(del.dataset.hazardDel);
    const src = hazardImgs[i];
    if (src) URL.revokeObjectURL(src);
    hazardImgs.splice(i, 1);
    renderHazardPhotos();
  });

  hazardFile.addEventListener("change", () => {
    const files = Array.from(hazardFile.files || []);
    files.forEach((file) => {
      if (hazardImgs.length >= 6 || !file.type.startsWith("image/")) return;
      hazardImgs.push(URL.createObjectURL(file));
    });
    hazardFile.value = "";
    renderHazardPhotos();
  });

  hazardTypes.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-hazard-type]");
    if (!btn) return;
    hazardKind = btn.dataset.hazardType;
    renderHazardTypes();
  });

  document.getElementById("btnHazardSubmit").addEventListener("click", () => {
    if (!hazardImgs.length) {
      showToast("请先拍摄或选择现场照片");
      return;
    }
    showToast("隐患已上报，待整改");
    closeHazard();
  });

  document.getElementById("btnAirBack").addEventListener("click", () => {
    if (airPop.classList.contains("open")) {
      airPop.classList.remove("open");
      airPop.hidden = true;
      return;
    }
    if (!airCal.classList.contains("hide")) {
      hideAirCal();
      return;
    }
    closeAir();
  });

  airDays.addEventListener("click", (e) => {
    const pick = e.target.closest("[data-air-cal-open]");
    if (pick) {
      if (airCal.classList.contains("hide")) showAirCal();
      else hideAirCal();
      return;
    }
    const btn = e.target.closest("[data-day]");
    if (!btn) return;
    hideAirCal();
    airDate = addDays(new Date(), -Number(btn.dataset.day));
    airPop.classList.remove("open");
    renderAir();
  });

  airCalPrev.addEventListener("click", () => {
    if (airCalPrev.disabled) return;
    airCalMonth.setMonth(airCalMonth.getMonth() - 1);
    renderAirCal();
  });

  airCalNext.addEventListener("click", () => {
    if (airCalNext.disabled) return;
    airCalMonth.setMonth(airCalMonth.getMonth() + 1);
    renderAirCal();
  });

  airCalGrid.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-cal]");
    if (!btn || btn.disabled) return;
    const [y, m, d] = btn.dataset.cal.split("-").map(Number);
    airDate = startOfDay(new Date(y, m - 1, d));
    hideAirCal();
    airPop.classList.remove("open");
    renderAir();
  });

  airGrid.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-air]");
    if (!btn) return;
    const shot = airList[Number(btn.dataset.air)];
    if (!shot) return;
    airPopImg.src = shot.img;
    airPopImg.className = shot.pos;
    airPopMeta.textContent = "定点航拍  " + formatCamDate(airDate) + "  " + shot.time;
    airPop.hidden = false;
    airPop.classList.add("open");
  });

  document.getElementById("btnAirClose").addEventListener("click", () => {
    airPop.classList.remove("open");
  });

  const landBuildings = siteBuildings.map((b) => ({
    name: b.name,
    pct: Math.round((b.done / b.total) * 100),
    late: b.plan === "滞后"
  }));
  const landEqIco = {
    crane: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 20h15"/><path d="M7 20V7.5h3.2V20"/><path d="M8.6 7.5H20l-3.2 6.2"/><path d="M16.8 13.7V20"/></svg>`,
    lift: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="3.5" width="10" height="17" rx="1.4"/><path d="M12 8.2v2.4M12 8.2l-1.2-1.2M12 8.2l1.2-1.2M12 15.6v-2.4M12 15.6l-1.2 1.2M12 15.6l1.2 1.2"/></svg>`,
    scale: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 17.5h15"/><path d="M7 17.5V9.2h10v8.3"/><path d="M9.2 9.2 12 5.8l2.8 3.4"/></svg>`,
    drone: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="6.2" cy="6.2" r="2"/><circle cx="17.8" cy="6.2" r="2"/><circle cx="6.2" cy="17.8" r="2"/><circle cx="17.8" cy="17.8" r="2"/><path d="M8.2 6.2h7.6M8.2 17.8h7.6M6.2 8.2v7.6M17.8 8.2v7.6"/><rect x="10" y="10" width="4" height="4" rx="0.8"/></svg>`,
    climb: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 20V5h10v15"/><path d="M7 9h10M7 13h10M7 17h10"/></svg>`,
    robot: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="8" width="12" height="10" rx="2"/><circle cx="9.5" cy="12.2" r="1"/><circle cx="14.5" cy="12.2" r="1"/><path d="M12 8V5.5M9 18.2v1.8M15 18.2v1.8"/></svg>`
  };
  const landDevices = siteEquip.map((d) => {
    const c = equipCount(d);
    return { name: d.name, on: c.on, total: c.total, ico: d.ico };
  });
  let landEqIdx = 0;
  let landEqTimer = 0;

  function landEqState(d) {
    if (d.on <= 0) return "off";
    if (d.on < d.total) return "warn";
    return "on";
  }

  function renderLandEq() {
    const box = document.getElementById("landEqCard");
    if (!box) return;
    const d = landDevices[landEqIdx];
    const st = landEqState(d);
    const dots = landDevices.map((_, n) => `<i class="${n === landEqIdx ? "on" : ""}"></i>`).join("");
    box.innerHTML = `
      <div class="land-eq-top">
        <span class="land-eq-ico">${landEqIco[d.ico]}</span>
        <strong>${d.name}</strong>
        <em class="land-eq-num ${st}"><i>${d.on}</i>/${d.total}</em>
      </div>
      <div class="land-eq-bot">
        <span class="land-qa-lab">在线 / 总数</span>
      </div>
      <div class="land-eq-dots">${dots}</div>`;
  }

  function startLandEq() {
    stopLandEq();
    renderLandEq();
    landEqTimer = setInterval(() => {
      landEqIdx = (landEqIdx + 1) % landDevices.length;
      renderLandEq();
    }, 3000);
  }

  function stopLandEq() {
    clearInterval(landEqTimer);
    landEqTimer = 0;
  }

  const landQaIco = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4.2 11.4 12 4.8l7.8 6.6V19a1.2 1.2 0 0 1-1.2 1.2h-4.4v-5.6H9.8V20.2H5.4A1.2 1.2 0 0 1 4.2 19z"/></svg>`;
  let landQaIdx = 0;
  let landQaTimer = 0;

  function renderLandQa() {
    const box = document.getElementById("landQaCard");
    if (!box) return;
    const d = qaCats[landQaIdx];
    const st = landQaState(d.now);
    const dots = qaCats.map((_, n) => `<i class="${n === landQaIdx ? "on" : ""}"></i>`).join("");
    box.innerHTML = `
      <div class="land-eq-top">
        <span class="land-eq-ico">${landQaIco}</span>
        <strong>${d.name}</strong>
        <em class="land-eq-num ${st}"><i>${d.now}%</i></em>
      </div>
      <div class="land-eq-bot">
        <span class="land-qa-lab">本月合格率</span>
      </div>
      <div class="land-eq-dots">${dots}</div>`;
  }

  function startLandQa() {
    stopLandQa();
    renderLandQa();
    landQaTimer = setInterval(() => {
      landQaIdx = (landQaIdx + 1) % qaCats.length;
      renderLandQa();
    }, 3000);
  }

  function stopLandQa() {
    clearInterval(landQaTimer);
    landQaTimer = 0;
  }

  function startLandKpis() {
    startLandPg();
    startLandEq();
    startLandQa();
  }

  function stopLandKpis() {
    stopLandPg();
    stopLandEq();
    stopLandQa();
  }

  let landPgSlide = 0;
  let landPgTimer = 0;
  const landPgSlides = Math.ceil(landBuildings.length / 2);

  function renderLandPg() {
    const n = landBuildings.length;
    const i = (landPgSlide * 2) % n;
    const pair = [landBuildings[i], landBuildings[(i + 1) % n]];
    const list = document.getElementById("landPgList");
    const dots = document.getElementById("landPgDots");
    if (!list || !dots) return;
    list.innerHTML = pair.map((b) => `
      <div class="land-pg-item${b.late ? " late" : ""}">
        <span>${b.name}</span>
        <i><em style="width:${b.pct}%"></em></i>
        <b>${b.pct}%</b>
      </div>`).join("");
    dots.innerHTML = Array.from({ length: landPgSlides }, (_, s) => `<i class="${s === landPgSlide ? "on" : ""}"></i>`).join("");
  }

  function startLandPg() {
    stopLandPg();
    renderLandPg();
    landPgTimer = setInterval(() => {
      landPgSlide = (landPgSlide + 1) % landPgSlides;
      renderLandPg();
    }, 3000);
  }

  function stopLandPg() {
    clearInterval(landPgTimer);
    landPgTimer = 0;
  }

  function openMapLand() {
    phone.classList.add("is-landscape");
    mapLand.hidden = false;
    mapLand.classList.add("open");
    mapLand.setAttribute("aria-hidden", "false");
  }

  function closeMapLand() {
    phone.classList.remove("is-landscape");
    mapLand.classList.remove("open");
    mapLand.setAttribute("aria-hidden", "true");
    mapLand.hidden = true;
  }

  document.getElementById("btnMapFull").addEventListener("click", openMapLand);
  document.getElementById("btnMapBack").addEventListener("click", closeMapLand);

  function tick() {
    const el = document.getElementById("statusTime");
    if (el) el.textContent = new Date().toTimeString().slice(0, 5);
    if (camPlayer.classList.contains("open")) camTime.textContent = camStamp();
    document.querySelectorAll(".cam-card-pic .cam-time").forEach((n) => { n.textContent = camStamp(); });
  }

  renderMsgs();
  renderMine();
  renderHomePanel(homeMod);
  tick();
  setInterval(tick, 1000);
})();
