// Approved Skills concept against real APIs and a disposable Hub. No inference.
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { mkdtemp, createService, cleanupFixtures, testBrowserEnvironment } from './fixtures.mjs';
import { seedWorkspaceFiles } from './workspace-files-ui.mjs';
import { selectControl } from './select-control.mjs';

export async function seedSkills(fixture) {
  const names=['feature-handoff','plan','workspace-authoring','game-ui-workflow','image-reference-workflow'];
  for (const agent of ['codex','claude','opencode']) {
    const folder=path.join(fixture.repo,agent==='claude'?'.claude':'.agents','skills');
    for (const [index,name] of names.entries()) {
      await mkdir(path.join(folder,name),{recursive:true});
      await writeFile(path.join(folder,name,'SKILL.md'),`---\nname: ${name}\ndescription: ${['Prepare a precise implementation handoff.','Turn a broad request into concrete steps.','Create cards, reports and Markdown deliverables.','Design and verify game interfaces.','Explore and revise visual references.'][index]}\n---\n\n# ${name}\n\n## Workflow\n\n- Inspect the current project and the relevant inputs.\n- Prepare the requested deliverable and preserve existing behavior.\n- Verify the result and document any remaining limitations.\n`);
      await fixture.service.projects.setHubSkillScope({id:name,scope:'global',enabled:index<3,agent});
    }
  }
  for (const folder of [fixture.project.repositoryPath,fixture.linked.repositoryPath]) for (const directory of ['.agents','.claude','.opencode']) {
    await mkdir(path.join(folder,directory,'skills/project-conventions'),{recursive:true});
    await writeFile(path.join(folder,directory,'skills/project-conventions/SKILL.md'),'---\nname: project-conventions\ndescription: Local project conventions.\n---\n\n# Project conventions\n\nPreserve this project.');
  }
}

export async function exerciseSkills(page, fixture) {
  await page.setViewportSize({width:1100,height:850});
  const errors=[]; page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(12000);
  const panelStyle = () => page.locator('.hub-rail-content').evaluate(el => {
    const style=getComputedStyle(el),header=el.querySelector('.files-panel>header'),picker=el.querySelector('[aria-label="Active workspace"]');
    return {width:el.getBoundingClientRect().width,background:style.backgroundColor,color:style.color,headerHeight:header.getBoundingClientRect().height,pickerHeight:picker.getBoundingClientRect().height,pickerBackground:getComputedStyle(picker).backgroundColor};
  });
  await page.getByRole('button',{name:'Toggle files',exact:true}).click();
  await selectControl(page,'Active workspace',fixture.project.id);
  const filesStyle=await panelStyle();
  await page.screenshot({path:'.cache/skills-consistency-files.png'});
  await page.getByRole('button',{name:'Toggle skills',exact:true}).click();
  await selectControl(page,'Active workspace',fixture.project.id);
  const panel=page.locator('.skills-panel'),agent=page.getByRole('group',{name:'Skill agent'}),source=page.getByRole('group',{name:'Skill location'}),view=page.getByRole('group',{name:'Skill view'});
  await expect.poll(() => panel.locator('.skill-catalog-row').count()).toBeGreaterThanOrEqual(5);
  assert.equal(await page.getByLabel('Folder path',{exact:true}).count(),0,'File browser is not duplicated in the catalog');
  assert.deepEqual(await panelStyle(),filesStyle,'Skills reuses Files panel palette, width, header and workspace selector');
  await panel.getByRole('button',{name:'feature-handoff',exact:false}).click();
  await expect(page.locator('.file-preview .markdown-document')).toBeVisible();
  assert.equal(await panel.evaluate(el=>getComputedStyle(el).backgroundColor),'rgba(0, 0, 0, 0)');
  const reading=page.locator('.skill-document:visible');
  await expect(reading.locator('.skill-document-heading h1')).toHaveCSS('font-size','25px');
  const title=await reading.locator('.skill-document-heading h1').boundingBox(),heading=await reading.locator('.mak-markdown h2').boundingBox();
  assert.ok(Math.abs(title.x-heading.x)<1,'Skill title and instructions share the concept alignment');
  assert.equal(await reading.locator('.markdown-reader').innerText().then(text=>text.includes('name: feature-handoff')),false,'Metadata is not rendered as Markdown content');
  const skillControl=panel.locator('.skill-catalog-row>.desk-dark-select').first();const controlBounds=await skillControl.boundingBox();assert.ok(controlBounds.width<=96&&controlBounds.height<=28,'Skill availability matches compact app controls');
  await page.screenshot({path:'.cache/skills-implemented-catalog.png'});
  await selectControl(page,'plan project setting','off');
  await expect(page.getByRole('combobox',{name:'plan project setting',exact:true})).toHaveAttribute('data-value','off');
  let scopes=JSON.parse(await readFile(path.join(fixture.repo,'projects/skill-scopes.json'),'utf8'));
  assert.equal(scopes.skills.plan.projects[fixture.project.id],false);
  await selectControl(page,'Active workspace','');
  await selectControl(page,'plan global setting','off');
  await selectControl(page,'Active workspace',fixture.project.id);
  await selectControl(page,'plan project setting','on');
  await selectControl(page,'plan project setting','inherited');
  await expect(page.getByRole('combobox',{name:'plan project setting',exact:true})).toContainText('Inherit · Off');
  await view.getByRole('button',{name:'Files',exact:true}).click();
  await expect(page.getByLabel('Folder path',{exact:true})).toHaveValue(/\.agents[\\/]skills$/);
  await page.getByRole('treeitem',{name:'feature-handoff',exact:false}).click();
  await page.getByRole('treeitem',{name:'SKILL.md',exact:false}).first().click();
  const markdown=page.locator('.markdown-document:visible');
  await markdown.getByRole('button',{name:'Edit',exact:true}).click();
  assert.match(await page.getByRole('textbox',{name:'Edit SKILL.md',exact:true}).inputValue(),/^---\r?\nname: feature-handoff/,'Editing preserves complete frontmatter');
  await page.getByRole('textbox',{name:'Edit SKILL.md',exact:true}).fill('# Edited fixture\n\nPreserved Markdown editor.');
  await markdown.getByRole('button',{name:'Save',exact:true}).click();
  await expect(markdown.getByRole('status')).toContainText('Saved');
  assert.match(await readFile(path.join(fixture.repo,'.agents/skills/feature-handoff/SKILL.md'),'utf8'),/Edited fixture/);
  await markdown.getByRole('button',{name:'Preview',exact:true}).click();
  await page.getByRole('button',{name:'Actions for SKILL.md',exact:true}).first().click();
  await page.getByRole('menuitem',{name:'Move to Recycle Bin',exact:true}).click();
  await page.getByRole('alertdialog',{name:'Move to Recycle Bin?',exact:true}).getByRole('button',{name:'Cancel',exact:true}).click();
  assert.match(await readFile(path.join(fixture.repo,'.agents/skills/feature-handoff/SKILL.md'),'utf8'),/Edited fixture/);
  await source.getByRole('button',{name:'Linked projects',exact:true}).click();
  await selectControl(page,'Native skill linked project',fixture.linked.id);
  await expect(page.getByLabel('Folder path',{exact:true})).toHaveValue(new RegExp(fixture.linked.repositoryPath.replace(/[/\\]/g,'[\\\\/]')+'.*skills$'));
  await view.getByRole('button',{name:'Skills',exact:true}).click();
  await expect(page.getByRole('region',{name:'Codex skill controls'})).toBeVisible();
  await page.getByRole('combobox',{name:'project-conventions native project setting',exact:true}).click();
  await page.screenshot({path:'.cache/skills-implemented-native-menu.png'});await page.keyboard.press('Escape');
  await selectControl(page,'project-conventions native project setting','off');
  await expect(page.getByRole('combobox',{name:'project-conventions native project setting',exact:true})).toHaveAttribute('data-value','off');
  for (const provider of ['Claude','OpenCode']) {
    await agent.getByRole('button',{name:provider,exact:true}).click();
    await expect(page.getByRole('region',{name:provider+' skill controls'})).toBeVisible();
    await page.getByRole('region',{name:provider+' skill controls'}).getByRole('button',{name:'project-conventions',exact:false}).click();
    await expect(page.locator('.file-preview:visible')).toContainText('Project conventions');
    await source.getByRole('button',{name:'Hub',exact:true}).click();
    await selectControl(page,'plan project setting','on');
    await source.getByRole('button',{name:'Linked projects',exact:true}).click();
  }
  await source.getByRole('button',{name:'Hub',exact:true}).click();
  await agent.getByRole('button',{name:'Codex',exact:true}).click();
  for (const target of ['hub','linked']) {
    await page.getByRole('button',{name:'Add skill',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'Add skill',exact:true});
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveCSS('border-radius','12px');
    await expect(dialog.getByLabel('Skill name',{exact:true})).toHaveCSS('background-color','rgb(26, 25, 33)');
    const bounds=await dialog.boundingBox(),size=page.viewportSize();
    assert.ok(Math.abs(bounds.x+bounds.width/2-size.width/2)<2&&Math.abs(bounds.y+bounds.height/2-size.height/2)<2,'Creation centered in workspace');
    if(target==='linked') {await dialog.getByRole('button',{name:'Linked project skill'}).click();await selectControl(page,'Skill linked project',fixture.linked.id)}
    await dialog.getByLabel('Skill name',{exact:true}).fill('new-'+target);
    await dialog.getByLabel('When should it be used?',{exact:true}).fill('Use for acceptance checks.');
    await dialog.getByLabel('Instructions',{exact:true}).fill('# Created skill\n\nKeep existing features.');
    await page.screenshot({path:`.cache/skills-implemented-create-${target}.png`});
    await dialog.getByRole('button',{name:'Create skill',exact:true}).click();
    await expect(dialog).toHaveCount(0);
    const file=path.join(target==='hub'?fixture.repo:fixture.linked.repositoryPath,'.agents/skills','new-'+target,'SKILL.md');
    assert.match(await readFile(file,'utf8'),/Keep existing features/);
    await expect(page.locator('.file-preview:visible')).toContainText('Created skill');
  }
  // One linked project: name only. Global Hub: linked-project tab unavailable.
  await selectControl(page,'Active workspace',fixture.other.id);
  await expect(page.getByRole('combobox',{name:'Native skill linked project'})).toHaveCount(0);
  await expect(page.locator('.skill-single-project')).toBeVisible();
  await selectControl(page,'Active workspace','');
  await expect(source.getByRole('button',{name:'Linked projects',exact:true})).toBeDisabled();
  scopes=JSON.parse(await readFile(path.join(fixture.repo,'projects/skill-scopes.json'),'utf8'));
  assert.equal(scopes.claudeSkills.plan.projects[fixture.project.id],true);
  assert.equal(scopes.opencodeSkills.plan.projects[fixture.project.id],true);
  assert.equal(scopes.skills.plan.projects?.[fixture.project.id],undefined);
  await page.getByRole('button',{name:'Refresh skills',exact:true}).click();
  for(const width of [1100,740,580,360,320]) {
    await page.setViewportSize({width,height:900});
    assert.ok(await panel.evaluate(el=>{const r=el.getBoundingClientRect();return r.left>=-1&&r.right<=innerWidth+1}),`Panel fits at ${width}`);
    await page.getByRole('button',{name:'Add skill',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'Add skill',exact:true});
    assert.ok(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1),`Dialog fits at ${width}`);
    await page.keyboard.press('Escape');
  }
  assert.deepEqual(errors,[]);
}

if(process.argv.includes('--run') && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let browser;
  try {
    const base=await mkdtemp(path.join(os.tmpdir(),'mik-skills-ui-')),repo=path.join(base,'Hub');
    for(const folder of ['workspace','inbox','knowledge','processes','context'])await mkdir(path.join(repo,folder),{recursive:true});await writeFile(path.join(repo,'workspace/workspace.json'),'{"entities":[]}');
    const service=await createService({repo,uiDir:path.resolve('dist'),mcpOptions:{home:path.join(base,'home'),env:{}}});
    const fixture=await seedWorkspaceFiles(service,repo,base);await seedSkills(fixture);
    browser=await chromium.launch({channel:'msedge',headless:true,env:testBrowserEnvironment()});
    const page=await browser.newPage({viewport:{width:1100,height:850}});await page.goto(service.urls.workspace);
    await exerciseSkills(page,fixture);console.log('PASS Skills real UI: approved layout, all providers/scopes, preview/edit/save, native controls, files/recycle guard, centered creation, responsive panels.');
  } finally {await browser?.close();await cleanupFixtures()}
}
