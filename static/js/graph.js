/**
 * 调用关系图模块
 * D3.js 横向树状图展示函数调用关系
 */
const Graph = {
    projectId: null,

    /**
     * 初始化调用关系图
     * @param {number} projectId
     */
    async init(projectId) {
        this.projectId = projectId;
        this._bindEvents();

        const container = document.getElementById('graph-container');
        const svg = document.getElementById('graph-svg');
        svg.innerHTML = '';

        let data;
        try {
            data = await API.getCallGraph(projectId);
        } catch (err) {
            container.innerHTML = `<div class="graph-empty">加载失败: ${err.message}</div>`;
            return;
        }

        if (!data.nodes || data.nodes.length === 0) {
            container.innerHTML = '<div class="graph-empty">暂无调用关系数据</div>';
            return;
        }

        // 确保svg元素存在（可能被上面的innerHTML清掉了）
        if (!document.getElementById('graph-svg')) {
            container.innerHTML = '<svg id="graph-svg"></svg>';
        }

        this._render(data);
    },

    /** 构建树结构 */
    _buildTree(nodes, links) {
        // 1. 找入口节点（不在任何link的target中）
        const targetIds = new Set(links.map(l => l.target));
        const roots = nodes.filter(n => !targetIds.has(n.id));

        // 2. 建立children映射 source -> [target ids]
        const childrenMap = {};
        links.forEach(l => {
            if (!childrenMap[l.source]) childrenMap[l.source] = [];
            childrenMap[l.source].push(l.target);
        });

        // 3. 节点id -> node映射
        const nodeMap = {};
        nodes.forEach(n => { nodeMap[n.id] = n; });

        // 4. 递归构建树（处理循环引用）
        const buildNode = (nodeId, visited) => {
            if (visited.has(nodeId)) return null;
            visited.add(nodeId);
            const node = nodeMap[nodeId];
            if (!node) return null;
            const childIds = childrenMap[nodeId] || [];
            const children = childIds
                .map(cid => buildNode(cid, new Set(visited)))
                .filter(Boolean);
            return {
                ...node,
                children: children.length ? children : undefined,
            };
        };

        // 5. 如果没有根节点，把所有节点当作根
        if (roots.length === 0) {
            return {
                id: -1, name: 'ROOT', virtual: true,
                children: nodes.map(n => buildNode(n.id, new Set())).filter(Boolean),
            };
        }

        // 6. 单根 vs 多根
        if (roots.length === 1) {
            return buildNode(roots[0].id, new Set());
        }
        return {
            id: -1, name: 'ROOT', virtual: true,
            children: roots.map(r => buildNode(r.id, new Set())).filter(Boolean),
        };
    },

    /** 渲染D3树状图 */
    _render(data) {
        const treeData = this._buildTree(data.nodes, data.links);
        if (!treeData) return;

        const container = document.getElementById('graph-container');
        const width = container.clientWidth;
        const height = container.clientHeight;

        const svg = d3.select('#graph-svg')
            .attr('width', width)
            .attr('height', height);

        svg.selectAll('*').remove();

        const g = svg.append('g');

        // 构建hierarchy
        const root = d3.hierarchy(treeData);
        const nodeCount = root.descendants().length;

        // 计算树布局尺寸
        const nodeSpacingY = 30;
        const treeHeight = Math.max(nodeCount * nodeSpacingY, height - 100);
        const treeWidth = Math.max(width - 200, 400);

        const treeLayout = d3.tree().size([treeHeight, treeWidth]);
        treeLayout(root);

        // 初始居中
        const initialX = 80;
        const initialY = (height - treeHeight) / 2;
        g.attr('transform', `translate(${initialX}, ${initialY})`);

        // 缩放平移
        const zoom = d3.zoom()
            .scaleExtent([0.1, 4])
            .on('zoom', (event) => {
                g.attr('transform', event.transform);
            });

        svg.call(zoom);

        // 初始transform
        svg.call(zoom.transform, d3.zoomIdentity.translate(initialX, initialY).scale(1));

        // 绘制连线
        g.selectAll('.graph-link')
            .data(root.links())
            .enter()
            .append('path')
            .attr('class', 'graph-link')
            .attr('d', d3.linkHorizontal()
                .x(d => d.y)
                .y(d => d.x)
            );

        // 绘制节点
        const projectId = this.projectId;
        const nodeGroup = g.selectAll('.graph-node')
            .data(root.descendants())
            .enter()
            .append('g')
            .attr('class', d => {
                let cls = 'graph-node';
                if (d.data.virtual) cls += ' virtual';
                if (d.data.has_notes) cls += ' has-notes';
                return cls;
            })
            .attr('transform', d => `translate(${d.y}, ${d.x})`)
            .style('cursor', d => d.data.virtual ? 'default' : 'pointer')
            .on('click', (event, d) => {
                if (d.data.virtual || d.data.id < 0) return;
                location.hash = `#/project/${projectId}/browse?func=${d.data.id}`;
            });

        nodeGroup.append('circle')
            .attr('r', 5);

        nodeGroup.append('text')
            .attr('x', d => d.children ? -10 : 10)
            .attr('text-anchor', d => d.children ? 'end' : 'start')
            .text(d => d.data.name || '');
    },

    /** 绑定事件 */
    _bindEvents() {
        if (this._bound) return;
        this._bound = true;

        document.getElementById('graph-back').addEventListener('click', () => {
            location.hash = `#/project/${this.projectId}/browse`;
        });
    },
};
