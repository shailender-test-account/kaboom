-- DEVELOPMENT ONLY: isolated draft content. Never updates existing destinations,
-- rules, recipients, enrollments or queues. $1 is the reviewed JSON content pack.
WITH raw AS (
  SELECT $1::jsonb AS doc
), guard AS (
  SELECT doc FROM raw
  WHERE (doc->>'tenantId')::int = 1 AND (doc->>'clientId')::int = 9
    AND EXISTS (SELECT 1 FROM clients WHERE id=9 AND tenant_id=1 AND name='HP')
    AND NOT EXISTS (
      SELECT 1 FROM journeys j, jsonb_array_elements(doc->'tracks') t
      WHERE j.slug=t->>'slug'
    )
    AND NOT EXISTS (
      SELECT 1 FROM email_sequences s
      WHERE s.tenant_id=1 AND s.client_id=9 AND s.name LIKE 'HP REVIEW — %'
    )
), tracks AS (
  SELECT doc, t FROM guard CROSS JOIN LATERAL jsonb_array_elements(doc->'tracks') t
), added_journeys AS (
  INSERT INTO journeys (tenant_id,client_id,name,slug,status,description)
  SELECT 1,9,'HP REVIEW — '||(t->>'name'),t->>'slug','draft',
    'Review only; no automatic routing or outreach. '||(t->>'mapping')
  FROM tracks RETURNING id,name,slug,status
), added_pages AS (
  INSERT INTO journey_pages
    (journey_id,title,page_type,content,sort_order,page_stage,score,
     is_published,cta_text,cta_enabled,cta_type,bi_category,bi_product)
  SELECT j.id,p->>'title','blocks',
    jsonb_build_object(
      'template','custom',
      'header',jsonb_build_object('show',true,'title','HP | '||(t->>'name'),'subtitle','Requirements-led briefing'),
      'footer',jsonb_build_object('show',true,'text','HP solution discussion · Scope and availability subject to confirmation'),
      'blocks',jsonb_build_array(
        jsonb_build_object('id','title','type','headline','text',p->>'title','level',1),
        jsonb_build_object('id','intro','type','text','text',p->>'intro'),
        jsonb_build_object('id','points','type','list','style','bullet','items',p->'bullets')
      )
    )::text,(n-1)::int,p->>'stage',0,
    false,CASE WHEN n<3 THEN 'Continue' ELSE NULL END,
    CASE WHEN n<3 THEN 'true' ELSE 'false' END,'next',t->>'category',t->>'product'
  FROM tracks JOIN added_journeys j ON j.slug=t->>'slug'
  CROSS JOIN LATERAL jsonb_array_elements(t->'pages') WITH ORDINALITY AS pp(p,n)
  RETURNING id,journey_id
), email_input AS (
  SELECT t,doc,j.id AS journey_id,e,n,
    'HP REVIEW — '||(t->>'name')||' — Email '||n AS template_name,
    (SELECT string_agg(v,E'\n\n' ORDER BY ord)
      FROM jsonb_array_elements_text(e->'paragraphs') WITH ORDINALITY p(v,ord))
      ||E'\n\nRead the briefing: '||(doc->>'productionOrigin')||'/hp/play/'||(t->>'slug')
      ||E'\n\nRegards,\nHP solutions team\n\nUnsubscribe: {{unsubscribeUrl}}' AS body
  FROM tracks JOIN added_journeys j ON j.slug=t->>'slug'
  CROSS JOIN LATERAL jsonb_array_elements(t->'emails') WITH ORDINALITY ee(e,n)
), added_templates AS (
  INSERT INTO email_templates (tenant_id,name,category,subject,body_text,body_html,variables)
  SELECT 1,template_name,'Outreach',e->>'subject',body,
    '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6;">'
    ||replace(replace(replace(replace(body,'&','&amp;'),'<','&lt;'),'>','&gt;'),E'\n','<br>')
    ||'<p><a href="'||(doc->>'productionOrigin')||'/hp/play/'||(t->>'slug')||'">Read the briefing</a></p>'
    ||'<p><a href="{{unsubscribeUrl}}">Unsubscribe</a></p></div>',
    '["firstName","unsubscribeUrl"]'::jsonb
  FROM email_input RETURNING id,name
), email_nodes AS (
  SELECT i.journey_id,i.n,
    jsonb_build_object('id','email-'||i.n,'type','email',
      'position',jsonb_build_object('x',200,'y',100+(i.n-1)*200),
      'data',jsonb_build_object('templateId',t.id,'templateName',t.name)) AS node
  FROM email_input i JOIN added_templates t ON t.name=i.template_name
), all_nodes AS (
  SELECT journey_id,0 AS rank,jsonb_build_object('id','trigger','type','trigger',
    'position',jsonb_build_object('x',200,'y',0),
    'data',jsonb_build_object('triggerType','MANUAL')) AS node FROM added_journeys j
    CROSS JOIN LATERAL (SELECT j.id AS journey_id) x
  UNION ALL
  SELECT journey_id,(2*n-1)::int,node FROM email_nodes
  UNION ALL
  SELECT j.id,2*n::int,jsonb_build_object('id','wait-'||n,'type','wait',
    'position',jsonb_build_object('x',200,'y',200*n),
    'data',jsonb_build_object('duration',CASE n WHEN 1 THEN 5 ELSE 7 END,'unit','days'))
  FROM added_journeys j CROSS JOIN generate_series(1,2) n
), edges AS (
  SELECT j.id AS journey_id,jsonb_agg(jsonb_build_object('id','edge-'||n,
    'source',(ARRAY['trigger','email-1','wait-1','email-2','wait-2'])[n],
    'target',(ARRAY['email-1','wait-1','email-2','wait-2','email-3'])[n]) ORDER BY n) AS value
  FROM added_journeys j CROSS JOIN generate_series(1,5) n GROUP BY j.id
), added_sequences AS (
  INSERT INTO email_sequences
    (tenant_id,client_id,journey_id,name,status,trigger_type,trigger_config,nodes_json)
  SELECT 1,9,j.id,j.name,'draft','MANUAL','{}'::jsonb,
    jsonb_build_object('nodes',(SELECT jsonb_agg(node ORDER BY rank) FROM all_nodes a WHERE a.journey_id=j.id),
      'edges',e.value)
  FROM added_journeys j JOIN edges e ON e.journey_id=j.id RETURNING id,name,journey_id,nodes_json,status
), added_steps AS (
  INSERT INTO sequence_steps
    (sequence_id,step_order,step_type,config,wait_duration,wait_unit,node_id)
  SELECT s.id,(n-2)::int,node->>'type',node->'data',
    CASE WHEN node->>'type'='wait' THEN (node->'data'->>'duration')::int ELSE NULL END,
    CASE WHEN node->>'type'='wait' THEN 'days' ELSE NULL END,node->>'id'
  FROM added_sequences s
  CROSS JOIN LATERAL jsonb_array_elements(s.nodes_json->'nodes') WITH ORDINALITY nn(node,n)
  WHERE node->>'type'<>'trigger' RETURNING id
)
SELECT
  (SELECT count(*) FROM added_journeys) AS journeys_created,
  (SELECT count(*) FROM added_pages) AS pages_created,
  (SELECT count(*) FROM added_templates) AS templates_created,
  (SELECT count(*) FROM added_sequences) AS sequences_created,
  (SELECT count(*) FROM added_steps) AS steps_created,
  (SELECT jsonb_agg(jsonb_build_object('journeyId',journey_id,'sequenceId',id,'name',name,'status',status))
    FROM added_sequences) AS drafts;
