// Post-set content presets, distilled from curated prompt libraries
// (YouMind awesome-nano-banana-pro-prompts, ZaynJarvis/aesthetics) and
// Xiaohongshu cover conventions (3:4, title headroom, tangible "氛围感").
//
// Each preset anchors the whole set:
// - styleAnchor: English style base that every shot prompt must embed verbatim
// - rhythm: shot pacing guidance for the storyboard planner
// - coverNote: extra requirement for shot 1 (e.g. title headroom on XHS)
// - platformAspect: default value for the platform/aspect select in the UI

/** Appended to every generated shot prompt for reliability. */
export const NEGATIVE_TAIL =
  'Natural anatomically correct hands and fingers, no watermark, no text overlay, no logo, no extra limbs.';

export const POST_PRESETS = [
  {
    id: 'xhs-cafe',
    name: '小红书 · 咖啡探店 plog',
    platformAspect: 'xhs|3:4',
    styleAnchor:
      'Photorealistic lifestyle photography in a cozy specialty coffee shop; soft natural window light with gentle shadows; warm low-saturation color grading with cream, caramel and wood tones; subtle film grain; shallow depth of field with a 35mm-50mm lens; candid unposed feeling, authentic skin texture, no over-retouching.',
    rhythm:
      '封面：人物+有记忆点的店内场景（七分身或全身）；后续：手持咖啡杯特写、窗边侧影、甜点与桌面静物细节、店内环境互动（点单/看菜单）、出店门口街拍收尾',
    coverNote: '封面上方留出约 1/4 高度的干净留白区域，方便后期加标题文字'
  },
  {
    id: 'xhs-ootd',
    name: '小红书 · OOTD 穿搭街拍',
    platformAspect: 'xhs|3:4',
    styleAnchor:
      'Street style fashion photography; natural daylight in an urban setting; clean modern color grading, slightly desaturated; 35mm lens at eye level or slightly low angle; realistic fabric texture and garment drape; authentic candid walking and standing poses, effortless confident energy.',
    rhythm:
      '封面：全身正面 OOTD 定点街拍；后续：背面全身、侧面行走抓拍、上半身叠穿与面料细节、鞋包配饰特写、回眸或倚墙坐姿收尾',
    coverNote: '封面上方留出约 1/4 高度的干净留白区域，方便后期加标题文字'
  },
  {
    id: 'xhs-home',
    name: '小红书 · 居家氛围感',
    platformAspect: 'xhs|3:4',
    styleAnchor:
      'Cozy at-home lifestyle photography; soft diffused morning light through sheer curtains; warm cream and beige palette, low contrast with a gentle glow; candid relaxed poses on a sofa, bed or by the window; realistic natural skin, subtle film grain, quiet intimate mood.',
    rhythm:
      '封面：窗边或沙发的松弛全身/七分身；后续：捧杯子或书的手部特写、逆光侧影、居家服细节、生活角落静物（早餐盘/绿植/床品）、伸懒腰或大笑的抓拍收尾',
    coverNote: '封面上方留出约 1/4 高度的干净留白区域，方便后期加标题文字'
  },
  {
    id: 'xhs-travel',
    name: '小红书 · 旅行 plog',
    platformAspect: 'xhs|3:4',
    styleAnchor:
      'Travel photojournalism style; bright airy natural light; clear blues and warm sunlit tones with a slight film fade; the subject placed within scenic wide establishing shots as well as closer candid moments; 28mm-50mm lens; genuine spontaneous expressions, wind-blown hair, rich real environment detail.',
    rhythm:
      '封面：人物置于标志性风景中的广角全身（人小景大或三分构图）；后续：回头看镜头的中景、走路背影、当地美食或车票细节、坐姿远眺侧影、夕阳剪影或跳跃抓拍收尾',
    coverNote: '封面上方留出约 1/4 高度的干净留白区域，方便后期加标题文字'
  },
  {
    id: 'ins-clean',
    name: 'Instagram · Clean Girl 极简',
    platformAspect: 'ins|4:5',
    styleAnchor:
      'Minimalist clean-girl aesthetic; neutral palette of ivory, sand and greige; soft even daylight with no harsh shadows; sleek styling, glowy natural makeup look, slicked-back or effortless hair; generous negative space and simple uncluttered backgrounds; premium editorial minimalism, crisp focus.',
    rhythm:
      '封面：大量留白的极简半身或全身；后续：素净背景的面部特写、金饰或指尖细节、镜面自拍、侧脸颈线光影、极简静物（香水/咖啡杯）穿插收尾',
    coverNote: ''
  },
  {
    id: 'ins-editorial',
    name: 'Instagram · Editorial 杂志街拍',
    platformAspect: 'ins|4:5',
    styleAnchor:
      'High-fashion editorial photography for a magazine spread; confident poses with strong silhouettes; dramatic yet natural light with deeper contrast; sophisticated muted color grading; 50mm-85mm lens with shallow depth of field; architectural urban backdrops, refined styling, cinematic mood.',
    rhythm:
      '封面：建筑背景前的强轮廓全身大片；后续：低角度仰拍、贴墙光影特写、走动动态虚化、服装剪裁细节、冷峻眼神近景收尾',
    coverNote: ''
  },
  {
    id: 'film',
    name: '胶片 Film Look',
    platformAspect: 'ins|4:5',
    styleAnchor:
      'Analog film photography look, shot on Kodak Portra 400; visible fine grain and soft halation on highlights; slightly faded blacks with a nostalgic warm-green color shift; natural imperfect framing like candid snapshots; authentic skin tones, ambient available light only, no digital sharpness.',
    rhythm:
      '封面：日常场景里的松弛全身快照感；后续：过曝逆光侧影、失焦前景遮挡的偷拍感中景、路边或车内的抓拍、光斑下的面部特写、背影走远收尾',
    coverNote: ''
  },
  {
    id: 'sport',
    name: '运动 Lifestyle',
    platformAspect: 'xhs|3:4',
    styleAnchor:
      'Athletic lifestyle photography; modern minimalist sportswear with realistic fabric texture; outdoor court, gym or park setting; crisp natural daylight with vibrant yet natural colors; dynamic but believable athletic poses mixed with rest moments; 50mm lens, accurate anatomy, light sheen of effort on skin.',
    rhythm:
      '封面：运动场景里的自信全身定点；后续：热身或拉伸动态、擦汗喝水的休息抓拍、鞋与装备细节、逆光剪影、坐地放松笑容收尾',
    coverNote: '封面上方留出约 1/4 高度的干净留白区域，方便后期加标题文字'
  }
];

export function getPreset(id) {
  return POST_PRESETS.find((p) => p.id === id) || null;
}
